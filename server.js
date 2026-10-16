require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

app.use('/assets', express.static(path.join(__dirname, 'assets')));

const upload = multer({ storage: multer.memoryStorage() });

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'SUA_URL_DO_SUPABASE';
const supabaseKey = process.env.SUPABASE_KEY || 'SUA_CHAVE_DO_SUPABASE';
const supabase = createClient(supabaseUrl, supabaseKey);

// Seu Token principal do Mercado Pago (Master)
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || 'APP_USR-3922552857820372-100920-07bc79655acaddc2ab1a10b9fd7e4f7a-71867761' 
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
let pagamentosPendentes = {}; 

app.use(express.static('www'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Verificar Status da Licença no Supabase (com suporte a link de indicação e WhatsApp do revendedor)
app.post('/api/licenca/verificar', async (req, res) => {
    const { deviceId, ref } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'ID obrigatório.' });

    try {
        let { data: licenca, error } = await supabase
            .from('licencas')
            .select('*')
            .eq('device_id', deviceId)
            .single();

        const agora = new Date();
        let revendedorId = null;

        if (!licenca) {
            if (ref) {
                let { data: rev } = await supabase.from('revendedores').select('id').eq('senha', ref).single();
                if (rev) revendedorId = rev.id;
            }

            const dataExpiracao = new Date();
            dataExpiracao.setHours(dataExpiracao.getHours() + 3);
            
            const novaLicenca = {
                device_id: deviceId,
                expiracao: dataExpiracao.toISOString(),
                plano: 'Teste Grátis (3h)',
                ativo: true,
                status_texto: 'Teste Ativo',
                revendedor_id: revendedorId
            };

            await supabase.from('licencas').insert([novaLicenca]);
            licenca = novaLicenca;
        } else if (ref && !licenca.revendedor_id) {
            let { data: rev } = await supabase.from('revendedores').select('id').eq('senha', ref).single();
            if (rev) {
                revendedorId = rev.id;
                await supabase.from('licencas').update({ revendedor_id: revendedorId }).eq('device_id', deviceId);
                licenca.revendedor_id = revendedorId;
            }
        }

        // Busca o WhatsApp do revendedor vinculado, se houver
        let whatsappRevendedor = "5511920065761"; // padrão caso não tenha revenda
        let targetRevId = licenca.revendedor_id || revendedorId;
        if (targetRevId) {
            let { data: revData } = await supabase.from('revendedores').select('whatsapp').eq('id', targetRevId).single();
            if (revData && revData.whatsapp) {
                whatsappRevendedor = revData.whatsapp.replace(/\D/g, '');
            }
        }

        const expiraEm = new Date(licenca.expiracao);
        const tempoRestanteMs = expiraEm - agora;

        if (tempoRestanteMs <= 0 || licenca.ativo === false) {
            await supabase.from('licencas').update({ ativo: false, status_texto: 'Bloqueado / Expirado' }).eq('device_id', deviceId);
            return res.json({ status: 'expirado', mensagem: 'Seu acesso expirou ou foi bloqueado.', whatsapp: whatsappRevendedor });
        }

        return res.json({
            status: 'ativo',
            plano: licenca.plano,
            expiracao: licenca.expiracao,
            tempoRestanteMs: tempoRestanteMs,
            whatsapp: whatsappRevendedor
        });
    } catch (err) {
        console.error("Erro ao verificar licença no Supabase:", err);
        return res.status(500).json({ error: 'Erro interno ao verificar licença.' });
    }
});

// 2. Gerar Pagamento PIX Real no Mercado Pago (Cliente Final - Usa token do revendedor se houver, senão avisa ausência se não configurado)
app.post('/api/pagamento/criar-pix', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'ID obrigatório.' });

    try {
        let mpClientToUse = client;
        let tokenRevendaValido = false;

        let { data: licenca } = await supabase.from('licencas').select('revendedor_id').eq('device_id', deviceId).single();
        if (licenca && licenca.revendedor_id) {
            let { data: rev } = await supabase.from('revendedores').select('token_mp').eq('id', licenca.revendedor_id).single();
            if (rev && rev.token_mp && rev.token_mp.trim().startsWith('APP_USR-')) {
                mpClientToUse = new MercadoPagoConfig({ accessToken: rev.token_mp.trim() });
                tokenRevendaValido = true;
            }
        }

        if (licenca && licenca.revendedor_id && !tokenRevendaValido) {
            return res.json({ success: true, semRevendedorToken: true });
        }

        const payment = new Payment(mpClientToUse);
        const body = {
            transaction_amount: 20.00,
            description: 'RotaShopee - Assinatura Mensal (30 Dias)',
            payment_method_id: 'pix',
            payer: { email: 'cliente@rotashopee.com' }
        };

        const response = await payment.create({ body });
        const paymentId = response.id;
        const qrCodeBase64 = response.point_of_interaction.transaction_data.qr_code_base64;
        const qrCodeCopiaCola = response.point_of_interaction.transaction_data.qr_code;

        pagamentosPendentes[paymentId] = deviceId;
        res.json({ success: true, paymentId, qrCodeBase64, qrCodeCopiaCola });
    } catch (error) {
        console.error("Erro ao gerar Pix:", error);
        res.status(500).json({ error: 'Erro ao conectar com o gateway de pagamento.' });
    }
});

// 3. Consultar Status do Pagamento do Cliente e Atualizar Supabase
app.post('/api/pagamento/verificar-status', async (req, res) => {
    const { paymentId, deviceId } = req.body;
    if (!paymentId || !deviceId) return res.status(400).json({ error: 'Dados incompletos.' });

    try {
        let mpClientToUse = client;
        let { data: licenca } = await supabase.from('licencas').select('revendedor_id').eq('device_id', deviceId).single();
        if (licenca && licenca.revendedor_id) {
            let { data: rev } = await supabase.from('revendedores').select('token_mp').eq('id', licenca.revendedor_id).single();
            if (rev && rev.token_mp && rev.token_mp.trim().startsWith('APP_USR-')) {
                mpClientToUse = new MercadoPagoConfig({ accessToken: rev.token_mp.trim() });
            }
        }

        const payment = new Payment(mpClientToUse);
        const response = await payment.get({ id: paymentId });

        if (response.status === 'approved') {
            let dataExpiracao = new Date();
            
            let { data: licencaAtual } = await supabase
                .from('licencas')
                .select('*')
                .eq('device_id', deviceId)
                .single();

            if (licencaAtual && new Date(licencaAtual.expiracao) > new Date()) {
                dataExpiracao = new Date(licencaAtual.expiracao);
            }
            dataExpiracao.setDate(dataExpiracao.getDate() + 30);

            const dadosAtualizados = {
                expiracao: dataExpiracao.toISOString(),
                plano: 'Plano 30 Dias',
                ativo: true,
                status_texto: 'Ativo (Pago)'
            };

            await supabase
                .from('licencas')
                .update(dadosAtualizados)
                .eq('device_id', deviceId);

            delete pagamentosPendentes[paymentId];
            return res.json({ aprovado: true, plano: 'Plano 30 Dias', expiracao: dataExpiracao.toISOString() });
        }

        return res.json({ aprovado: false, status: response.status });
    } catch (error) {
        console.error("Erro ao consultar status:", error);
        return res.json({ aprovado: false });
    }
});

// ==========================================
// COMPRA DE CRÉDITOS DO REVENDA (PIX REAL DO MASTER)
// ==========================================
app.post('/api/revenda/comprar-creditos-pix', async (req, res) => {
    const senha = req.headers['authorization'];
    const { qtd, valor } = req.body;
    if (!senha || !qtd || !valor) return res.status(400).json({ success: false, message: 'Dados incompletos.' });

    try {
        let { data: rev } = await supabase.from('revendedores').select('id, nome').eq('senha', senha).single();
        if (!rev) return res.status(401).json({ success: false, message: 'Revendedor não autorizado.' });

        const payment = new Payment(client);
        const body = {
            transaction_amount: parseFloat(valor),
            description: `Recarga de ${qtd} Créditos - RotaShopee (${rev.nome})`,
            payment_method_id: 'pix',
            payer: { email: 'revendedor@rotashopee.com' }
        };

        const response = await payment.create({ body });
        const paymentId = response.id;
        const qrCodeBase64 = response.point_of_interaction.transaction_data.qr_code_base64;
        const qrCodeCopiaCola = response.point_of_interaction.transaction_data.qr_code;

        res.json({ success: true, paymentId, qrCodeBase64, qrCodeCopiaCola, qtd });
    } catch (error) {
        console.error("Erro ao gerar Pix de créditos:", error);
        res.status(500).json({ success: false, message: 'Erro ao conectar com o Mercado Pago.' });
    }
});

app.post('/api/revenda/verificar-creditos-pix', async (req, res) => {
    const senha = req.headers['authorization'];
    const { paymentId, qtd } = req.body;
    if (!senha || !paymentId || !qtd) return res.status(400).json({ success: false, message: 'Dados incompletos.' });

    try {
        let { data: rev } = await supabase.from('revendedores').select('id, creditos').eq('senha', senha).single();
        if (!rev) return res.status(401).json({ success: false, message: 'Não autorizado.' });

        const payment = new Payment(client);
        const response = await payment.get({ id: paymentId });

        if (response.status === 'approved') {
            const novoSaldo = (rev.creditos || 0) + parseInt(qtd);
            await supabase.from('revendedores').update({ creditos: novoSaldo }).eq('id', rev.id);

            return res.json({ aprovado: true, novoSaldo });
        }

        return res.json({ aprovado: false });
    } catch (e) {
        console.error("Erro ao verificar pagamento de créditos:", e);
        res.json({ aprovado: false });
    }
});

// ==========================================
// ROTAS PARA ATUALIZAR WHATSAPP E TOKEN MP DO REVENDEDOR
// ==========================================
app.post('/api/revenda/atualizar-whatsapp', async (req, res) => {
    const senha = req.headers['authorization'];
    const { whatsapp } = req.body;
    if (!senha) return res.status(401).json({ success: false, message: 'Não autorizado' });

    try {
        let { data: rev } = await supabase.from('revendedores').select('id').eq('senha', senha).single();
        if (!rev) return res.status(401).json({ success: false, message: 'Revendedor não encontrado' });

        const { error } = await supabase.from('revendedores').update({ whatsapp: whatsapp || '' }).eq('id', rev.id);
        if (error) throw error;

        res.json({ success: true, whatsapp });
    } catch (e) {
        console.error("Erro ao atualizar WhatsApp do revendedor:", e);
        res.status(500).json({ success: false, message: 'Erro ao atualizar WhatsApp' });
    }
});

app.post('/api/revenda/atualizar-token-mp', async (req, res) => {
    const senha = req.headers['authorization'];
    const { tokenMp } = req.body;
    if (!senha) return res.status(401).json({ success: false, message: 'Não autorizado' });

    try {
        let { data: rev } = await supabase.from('revendedores').select('id').eq('senha', senha).single();
        if (!rev) return res.status(401).json({ success: false, message: 'Revendedor não encontrado' });

        const { error } = await supabase.from('revendedores').update({ token_mp: tokenMp || '' }).eq('id', rev.id);
        if (error) throw error;

        res.json({ success: true, tokenMp });
    } catch (e) {
        console.error("Erro ao atualizar Token MP do revendedor:", e);
        res.status(500).json({ success: false, message: 'Erro ao atualizar Token MP' });
    }
});

// ==========================================
// ROTAS DE PAINEL DISPOSITIVOS (ISOLADO POR REVENDA)
// ==========================================

app.get('/api/admin/dispositivos', async (req, res) => {
    const senha = req.headers['authorization'];
    if (!senha) return res.status(401).json({ success: false, message: 'Não autorizado' });

    try {
        let query = supabase.from('licencas').select('*');

        if (senha !== 'master123') {
            let { data: rev } = await supabase.from('revendedores').select('id, ativo').eq('senha', senha).single();
            if (!rev || rev.ativo === false) {
                return res.status(403).json({ success: false, message: 'Revenda bloqueada' });
            }
            query = query.eq('revendedor_id', rev.id);
        }

        let { data: dispositivos, error } = await query;
        if (error) throw error;

        const listaFormatada = (dispositivos || []).map(item => {
            const expirado = new Date(item.expiracao) < new Date() || item.ativo === false;
            return {
                deviceId: item.device_id,
                expiracao: item.expiracao,
                plano: item.plano,
                ativo: !expirado,
                statusTexto: expirado ? 'Offline / Expirado' : 'Online (App Aberto)'
            };
        });

        res.json({ success: true, dispositivos: listaFormatada });
    } catch (e) {
        console.error("Erro ao buscar dispositivos no Supabase:", e);
        res.status(500).json({ success: false, message: 'Erro ao carregar dispositivos' });
    }
});

app.post('/api/admin/liberar', async (req, res) => {
    const senha = req.headers['authorization'];
    if (!senha) return res.status(401).json({ success: false, message: 'Não autorizado' });

    const { deviceId, dias } = req.body;
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID obrigatório.' });

    try {
        let revId = null;
        if (senha !== 'master123') {
            let { data: rev } = await supabase.from('revendedores').select('id, creditos, ativo').eq('senha', senha).single();
            if (!rev || rev.ativo === false) return res.status(403).json({ success: false, message: 'Revenda bloqueada' });
            
            if (dias > 0) {
                if ((rev.creditos || 0) < 1) return res.status(400).json({ success: false, message: 'Créditos insuficientes' });
                await supabase.from('revendedores').update({ creditos: rev.creditos - 1 }).eq('id', rev.id);
            }
            revId = rev.id;
        }

        let dataExpiracao = new Date();
        let novosDados = {};

        let { data: licencaAtual } = await supabase
            .from('licencas')
            .select('*')
            .eq('device_id', deviceId)
            .single();

        if (dias > 0) {
            if (licencaAtual && new Date(licencaAtual.expiracao) > new Date()) {
                dataExpiracao = new Date(licencaAtual.expiracao);
            }
            dataExpiracao.setDate(dataExpiracao.getDate() + dias);
            novosDados = {
                expiracao: dataExpiracao.toISOString(),
                plano: `Plano Revenda (${dias} Dias)`,
                ativo: true,
                status_texto: 'Ativo (Liberado)',
                ...(revId && { revendedor_id: revId })
            };
        } else {
            dataExpiracao = new Date(0);
            novosDados = {
                expiracao: dataExpiracao.toISOString(),
                plano: 'Bloqueado',
                ativo: false,
                status_texto: 'Bloqueado'
            };
        }

        if (licencaAtual) {
            await supabase.from('licencas').update(novosDados).eq('device_id', deviceId);
        } else {
            novosDados.device_id = deviceId;
            await supabase.from('licencas').insert([novosDados]);
        }

        res.json({ success: true, deviceId, expiracao: dataExpiracao.toISOString() });
    } catch (e) {
        console.error("Erro ao atualizar licença no Supabase:", e);
        res.status(500).json({ success: false, message: 'Erro ao atualizar licença' });
    }
});

// ==========================================
// ROTAS DO PAINEL MASTER (GESTÃO DE REVENDAS E CLIENTES)
// ==========================================

app.get('/api/master/revendas', async (req, res) => {
    const senha = req.headers['authorization'];
    if (senha !== 'master123') return res.status(401).json({ success: false, message: 'Não autorizado' });

    try {
        let { data, error } = await supabase.from('revendedores').select('*');
        if (error) throw error;
        res.json({ success: true, revendas: data || [] });
    } catch (e) {
        console.error("Erro ao buscar revendas:", e);
        res.status(500).json({ success: false, message: 'Erro ao buscar revendas' });
    }
});

// Rota corrigida e segura para o Master ver TODOS os clientes finais do sistema
app.get('/api/master/clientes', async (req, res) => {
    const senha = req.headers['authorization'];
    if (senha !== 'master123') return res.status(401).json({ success: false, message: 'Não autorizado' });

    try {
        let { data: licencas, error } = await supabase.from('licencas').select('*');
        if (error) throw error;

        let { data: revendedores } = await supabase.from('revendedores').select('id, nome');
        let revMap = {};
        if (revendedores) {
            revendedores.forEach(r => { revMap[r.id] = r.nome; });
        }

        const listaFormatada = (licencas || []).map(item => {
            const expirado = new Date(item.expiracao) < new Date() || item.ativo === false;
            let nomeRevenda = 'Cliente Direto (Master)';
            if (item.revendedor_id && revMap[item.revendedor_id]) {
                nomeRevenda = revMap[item.revendedor_id];
            }

            return {
                deviceId: item.device_id,
                expiracao: item.expiracao,
                plano: item.plano,
                ativo: !expirado,
                statusTexto: expirado ? 'Offline / Expirado' : 'Online (App Aberto)',
                revendedorNome: nomeRevenda
            };
        });

        res.json({ success: true, clientes: listaFormatada });
    } catch (e) {
        console.error("Erro ao buscar clientes no Master:", e);
        res.status(500).json({ success: false, message: 'Erro ao carregar clientes' });
    }
});

app.post('/api/master/revenda/salvar', async (req, res) => {
    const senha = req.headers['authorization'];
    if (senha !== 'master123') return res.status(401).json({ success: false, message: 'Não autorizado' });

    const { nome, usuario, senhaRevenda, creditos, tokenMp, whatsapp } = req.body;
    try {
        const { error } = await supabase.from('revendedores').insert([
            { nome, usuario, senha: senhaRevenda, creditos: creditos || 0, token_mp: tokenMp || '', whatsapp: whatsapp || '', ativo: true }
        ]);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao salvar revendedor:", e);
        res.status(500).json({ success: false, message: 'Erro ao criar revendedor' });
    }
});

app.post('/api/master/revenda/creditos', async (req, res) => {
    const senha = req.headers['authorization'];
    if (senha !== 'master123') return res.status(401).json({ success: false, message: 'Não autorizado' });

    const { id, qtd } = req.body;
    try {
        let { data: rev, error: errFind } = await supabase.from('revendedores').select('creditos').eq('id', id).single();
        if (errFind || !rev) return res.status(404).json({ success: false, message: 'Revendedor não encontrado' });

        const novoSaldo = (rev.creditos || 0) + qtd;
        await supabase.from('revendedores').update({ creditos: novoSaldo }).eq('id', id);
        res.json({ success: true, novoSaldo });
    } catch (e) {
        console.error("Erro ao atualizar créditos:", e);
        res.status(500).json({ success: false, message: 'Erro ao atualizar créditos' });
    }
});

app.post('/api/master/revenda/status', async (req, res) => {
    const senha = req.headers['authorization'];
    if (senha !== 'master123') return res.status(401).json({ success: false, message: 'Não autorizado' });

    const { id, ativo } = req.body;
    try {
        await supabase.from('revendedores').update({ ativo }).eq('id', id);
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao alterar status da revenda:", e);
        res.status(500).json({ success: false, message: 'Erro ao alterar status' });
    }
});

app.post('/api/master/revenda/excluir', async (req, res) => {
    const senha = req.headers['authorization'];
    if (senha !== 'master123') return res.status(401).json({ success: false, message: 'Não autorizado' });

    const { id } = req.body;
    try {
        await supabase.from('revendedores').delete().eq('id', id);
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao excluir revenda:", e);
        res.status(500).json({ success: false, message: 'Erro ao excluir revenda' });
    }
});

app.post('/api/revenda/login', async (req, res) => {
    const { senha } = req.body;
    if (!senha) return res.status(400).json({ success: false, message: 'Palavra-chave obrigatória' });

    try {
        let { data: rev, error } = await supabase
            .from('revendedores')
            .select('*')
            .eq('senha', senha)
            .single();

        if (error || !rev) {
            return res.status(401).json({ success: false, message: 'Palavra-Chave incorreta!' });
        }

        if (rev.ativo === false) {
            return res.status(403).json({ success: false, message: 'A sua conta de revenda está bloqueada pelo Administrador Master!' });
        }

        res.json({ 
            success: true, 
            revendedor: {
                id: rev.id,
                nome: rev.nome,
                creditos: rev.creditos,
                tokenMp: rev.token_mp || '',
                whatsapp: rev.whatsapp || ''
            }
        });
    } catch (e) {
        console.error("Erro no login da revenda:", e);
        res.status(500).json({ success: false, message: 'Erro no login' });
    }
});

// ==========================================

app.post('/api/extrair-enderecos', upload.any(), async (req, res) => {
    try {
        const file = (req.files && req.files.length > 0) ? req.files[0] : req.file;
        if (!file) return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });

        const fileBuffer = file.buffer;
        const mimeType = file.mimetype || '';
        const fileName = file.originalname || '';
        let textoExtraido = "";

        if (mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
            try {
                const pdfData = await pdfParse(fileBuffer);
                textoExtraido = pdfData.text;
            } catch (pdfErr) {
                textoExtraido = fileBuffer.toString('utf8');
            }
        } else {
            const imagePart = {
                inlineData: {
                    data: fileBuffer.toString("base64"),
                    mimeType: mimeType || 'image/jpeg'
                },
            };
            const prompt = `Analise esta imagem e extraia todos os endereços, ruas e CEPs de entrega listados nela.`;
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [prompt, imagePart]
            });
            textoExtraido = response.text;
        }

        if (!textoExtraido || textoExtraido.trim().length === 0) {
            return res.json({ success: true, enderecos: [] });
        }

        const promptJson = `A partir do texto abaixo, extraia todos os endereços de entrega (ruas, avenidas, CEPs) formatados em sequência.
Retorne APENAS um array JSON puro contendo strings com os endereços limpos (ex: ["Rua A, 123", "Av B, 456, CEP 11000-000"]). 
Não inclua nenhum texto ou formatação markdown adicional fora do array JSON. Se não encontrar endereços, retorne [].

Texto:
${textoExtraido}`;

        const aiResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: promptJson
        });

        let textoResposta = aiResponse.text.trim();
        textoResposta = textoResposta.replace(/```json/g, '').replace(/```/g, '').trim();
        const enderecos = JSON.parse(textoResposta);

        return res.json({ success: true, enderecos });

    } catch (error) {
        console.error("Erro detalhado na rota extrair-enderecos:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/geocodificar', async (req, res) => {
    const { endereco } = req.body;
    if (!endereco) return res.status(400).json({ error: 'Endereço obrigatório.' });

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco + ', Brasil')}&limit=1`;
        const response = await fetch(url, {
            headers: { 
                'User-Agent': 'RotaShopeeApp/2.5 (contato@rotashopee.com)' 
            }
        });

        const textResponse = await response.text();
        
        if (!textResponse.startsWith('[') && !textResponse.startsWith('{')) {
            return res.json({ success: false, error: 'Resposta inválida do serviço de mapas' });
        }

        const data = JSON.parse(textResponse);

        if (data && data.length > 0) {
            return res.json({ success: true, lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) });
        }
        return res.json({ success: false });
    } catch (error) {
        console.error("Erro na geocodificação:", error.message);
        return res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor RotaShopee rodando em http://localhost:${PORT}`);
});