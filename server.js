const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'agendamentos.json');

// Middlewares essenciais para ler o corpo das requisições corretamente
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Garante que o arquivo JSON existe e está íntegro
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
}

// Rota para salvar dados (agendamentos ou cadastros)
app.post('/api/salvar', (req, res) => {
    try {
        const novosDados = req.body;
        
        // Validade básica para não salvar vazio
        if (!novosDados.tipo) {
            return res.status(400).json({ sucesso: false, mensagem: 'Dados incompletos.' });
        }

        let registros = [];
        const arquivoConteudo = fs.readFileSync(DB_FILE, 'utf8');
        
        if (arquivoConteudo.trim() !== '') {
            registros = JSON.parse(arquivoConteudo);
        }

        novosDados.id = Date.now();
        novosDados.dataRegistro = new Date().toLocaleString('pt-BR');
        registros.push(novosDados);

        // Salva de forma síncrona garantindo a gravação no disco
        fs.writeFileSync(DB_FILE, JSON.stringify(registros, null, 2), 'utf8');
        
        console.log('Registro salvo com sucesso:', novosDados);
        res.json({ sucesso: true, mensagem: 'Salvo com sucesso!', id: novosDados.id });
    } catch (erro) {
        console.error('Erro ao salvar no arquivo:', erro);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno ao salvar.' });
    }
});

// Rota para listar agendamentos no painel admin
app.get('/api/agendamentos', (req, res) => {
    try {
        if (!fs.existsSync(DB_FILE)) {
            return res.json([]);
        }
        const arquivoConteudo = fs.readFileSync(DB_FILE, 'utf8');
        const registros = arquivoConteudo.trim() === '' ? [] : JSON.parse(arquivoConteudo);
        res.json(registros);
    } catch (erro) {
        console.error('Erro ao ler agendamentos:', erro);
        res.json([]);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando perfeitamente em http://localhost:${PORT}`);
});