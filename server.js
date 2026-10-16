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

const upload = multer({ storage: multer.memoryStorage() });

// Configuração do Supabase (adicione SUPABASE_URL e SUPABASE_KEY no seu .env)
const supabaseUrl = process.env.SUPABASE_URL || 'SUA_URL_DO_SUPABASE';
const supabaseKey = process.env.SUPABASE_KEY || 'SUA_CHAVE_DO_SUPABASE';
const supabase = createClient(supabaseUrl, supabaseKey);

const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || 'APP_USR-3922552857820372-100920-07bc79655acaddc2ab1a10b9fd7e4f7a-71867761' 
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
let pagamentosPendentes = {}; 

app.use(express.static('www'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Verificar Status da Licença no Supabase
app.post('/api/licenca/verificar', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'ID obrigatório.' });

    try {
        let { data: licenca, error } = await supabase
            .from('licencas')
            .select('*')
            .eq('device_id', deviceId)
            .single();

        const agora = new Date();

        if (!licenca) {
            // Criar teste grátis de 3 horas no Supabase para novos dispositivos
            const dataExpiracao = new Date();
            dataExpiracao.setHours(dataExpiracao.getHours() + 3);
            
            const novaLicenca = {
                device_id: deviceId,
                expiracao: dataExpiracao.toISOString(),
                plano: 'Teste Grátis (3h)',
                ativo: true,
                status_texto: 'Teste Ativo'
            };

            await supabase.from('licencas').insert([novaLicenca]);
            licenca = novaLicenca;
        }

        const expiraEm = new Date(licenca.expiracao);
        const tempoRestanteMs = expiraEm - agora;

        if (tempoRestanteMs <= 0 || licenca.ativo === false) {
            await supabase.from('licencas').update({ ativo: false, status_texto: 'Bloqueado / Expirado' }).eq('device_id', deviceId);
            return res.json({ status: 'expirado', mensagem: 'Seu acesso expirou ou foi bloqueado pelo administrador.' });
        }

        return res.json({
            status: 'ativo',
            plano: licenca.plano,
            expiracao: licenca.expiracao,
            tempoRestanteMs: tempoRestanteMs
        });
    } catch (err) {
        console.error("Erro ao verificar licença no Supabase:", err);
        return res.status(500).json({ error: 'Erro interno ao verificar licença.' });
    }
});

// 2. Gerar Pagamento PIX Real no Mercado Pago
app.post('/api/pagamento/criar-pix', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'ID obrigatório.' });

    try {
        const payment = new Payment(client);
        const body = {
            transaction_amount: 20.00,
            description: 'RotaShopee - Assinatura Mensal (30 Dias)',
            payment_method_id: 'pix',
            payer: { email: 'cliente@rotaShopee.com' }
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

// 3. Consultar Status do Pagamento e Atualizar Supabase
app.post('/api/pagamento/verificar-status', async (req, res) => {
    const { paymentId, deviceId } = req.body;
    if (!paymentId || !deviceId) return res.status(400).json({ error: 'Dados incompletos.' });

    try {
        const payment = new Payment(client);
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
// ROTAS DO PAINEL ADMINISTRATIVO (SUPABASE)
// ==========================================

app.get('/api/admin/dispositivos', async (req, res) => {
    const senha = req.headers['authorization'];
    if (senha !== 'admin123') {
        return res.status(401).json({ success: false, message: 'Não autorizado' });
    }

    try {
        let { data: dispositivos, error } = await supabase
            .from('licencas')
            .select('*');

        if (error) throw error;

        const listaFormatada = dispositivos.map(item => {
            const expirado = new Date(item.expiracao) < new Date() || item.ativo === false;
            return {
                deviceId: item.device_id,
                expiracao: item.expiracao,
                plano: item.plano,
                ativo: !expirado,
                statusTexto: expirado ? 'Bloqueado / Expirado' : (item.status_texto || item.plano || 'Ativo')
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
    if (senha !== 'admin123') {
        return res.status(401).json({ success: false, message: 'Não autorizado' });
    }

    const { deviceId, dias } = req.body;
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID obrigatório.' });

    try {
        let dataExpiracao = new Date();
        let novosDados = {};

        let { data: licencaAtual } = await supabase
            .from('licencas')
            .select('*')
            .eq('device_id', deviceId)
            .single();

        if (dias === 'teste3h') {
            dataExpiracao.setHours(dataExpiracao.getHours() + 3);
            novosDados = {
                expiracao: dataExpiracao.toISOString(),
                plano: 'Teste Grátis (3h)',
                ativo: true,
                status_texto: 'Teste 3h Ativo'
            };
        } else if (dias > 0) {
            if (licencaAtual && new Date(licencaAtual.expiracao) > new Date()) {
                dataExpiracao = new Date(licencaAtual.expiracao);
            }
            dataExpiracao.setDate(dataExpiracao.getDate() + dias);
            novosDados = {
                expiracao: dataExpiracao.toISOString(),
                plano: `Plano Admin (${dias} Dias)`,
                ativo: true,
                status_texto: 'Ativo (Liberado Admin)'
            };
        } else {
            dataExpiracao = new Date(0);
            novosDados = {
                expiracao: dataExpiracao.toISOString(),
                plano: 'Bloqueado',
                ativo: false,
                status_texto: 'Bloqueado pelo Admin'
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

// 4. Rota para Extrair Endereços de PDF ou Fotos
app.post('/api/extrair-enderecos', upload.any(), async (req, res) => {
    try {
        const file = (req.files && req.files.length > 0) ? req.files[0] : req.file;
        
        if (!file) {
            return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });
        }

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

// 5. Rota segura de Geocodificação
app.post('/api/geocodificar', async (req, res) => {
    const { endereco } = req.body;
    if (!endereco) return res.status(400).json({ error: 'Endereço obrigatório.' });

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco + ', Brasil')}&limit=1`;
        const response = await fetch(url, {
            headers: { 
                'User-Agent': 'RotaFacilApp/2.3 (contato@rotafacil.com)' 
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
    console.log(`🚀 Servidor RotaFácil rodando em http://localhost:${PORT}`);
});