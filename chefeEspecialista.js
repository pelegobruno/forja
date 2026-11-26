const { admin, getDb } = require('./firebase');

function resumirParaSuperior({ chatId, textoRecebido, respostaSecretaria, sessao, mem }) {
    const telefoneOuId = chatId.split('@')[0];
    const nome = mem?.nomeIdentificado || 'Não identificado';
    const fluxo = sessao?.etapa || mem?.fluxoAtual || 'MENU';
    const temas = Array.isArray(mem?.temasVistos) && mem.temasVistos.length
        ? mem.temasVistos.join(', ')
        : 'Nenhum';

    let prioridade = 'NORMAL';
    let acaoSugerida = 'Manter atendimento automatizado de triagem.';

    if (fluxo.endsWith('_ANDAMENTO')) {
        prioridade = 'ALTA';
        acaoSugerida = 'Conferir dados de triagem registrados para encaminhamento/agendamento.';
    } else if (/valor|preco|custa|pix|70/i.test(textoRecebido)) {
        prioridade = 'MEDIA';
        acaoSugerida = 'Acompanhar dúvida sobre valores/pagamento.';
    } else if (/horario|agenda|agendar|marcar/i.test(textoRecebido)) {
        prioridade = 'MEDIA';
        acaoSugerida = 'Verificar disponibilidade de agenda para o contato.';
    }

    return {
        chatId,
        contato: telefoneOuId,
        nomeCliente: nome,
        fluxoAtual: fluxo,
        temasVistos: temas,
        prioridade,
        acaoSugerida,
        ultimaEntradaCliente: textoRecebido,
        respostaEnviada: respostaSecretaria,
        atualizadoEmTexto: new Date().toLocaleString('pt-BR')
    };
}

async function registrarParecerSuperior(parecer) {
    const db = getDb();
    if (!db) return;

    try {
        const docId = parecer.chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
        await db.collection('supervisao_chefe').doc(docId).set(
            {
                ...parecer,
                atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
        );
    } catch (e) {
        console.error('[ERRO supervisao_chefe]', e.message);
    }
}

function refinarRespostaChefe({ respostaBase, mem, sessao, textoAgrupado }) {
    if (!respostaBase || typeof respostaBase !== 'string') return '';

    let texto = respostaBase.trim();

    // Evita repetir saudação genérica se o nome já foi capturado e o texto não já começa com ele
    if (mem?.nomeIdentificado && /^oi\b|^olá\b|^ola\b/i.test(texto) && !texto.includes(mem.nomeIdentificado)) {
        texto = texto.replace(/^(oi|olá|ola)[!,.]?\s*/i, `Olá, ${mem.nomeIdentificado}! `);
    }

    // Se houver triagem salva, reforça clareza de próximo passo sem duplicar linhas
    if (sessao?.etapa === 'MENU' && /triagem/i.test(textoAgrupado) && !/equipe|retorno/i.test(texto)) {
        texto = `${texto}\n\nNossa equipe já recebeu o registro e dará sequência assim que possível.`;
    }

    return texto.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
    resumirParaSuperior,
    registrarParecerSuperior,
    refinarRespostaChefe
};