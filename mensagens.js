const MENSAGENS = {
    MENU:
        "Olá! Aqui é a secretaria virtual do *Instituto Forja*.\n\n" +
        "Como posso te ajudar hoje?\n" +
        "*1* — CRAS (encaminhamento)\n" +
        "*2* — SCFV Idosos (60+)\n" +
        "*3* — Particular / RAF (avaliação)\n" +
        "*4* — Valores\n" +
        "*5* — Horários\n\n" +
        "Se preferir, pode escrever com suas palavras ou digitar *resumo* para vermos o que já falamos e *menu* para voltar aqui.",

    CRAS:
        "Certo, vamos organizar o atendimento via *CRAS*.\n\n" +
        "Quando puder, me informe em uma mensagem:\n" +
        "• Seu nome completo\n" +
        "• Quantos filhos moram com você e as idades\n" +
        "• Se já possui documento de encaminhamento",

    SCFV:
        "Perfeito, vamos cuidar do acolhimento para o *SCFV Idosos (60+)*.\n\n" +
        "Me envie em uma mensagem:\n" +
        "• Nome e idade da pessoa idosa\n" +
        "• Nome e telefone do responsável",

    PARTICULAR:
        "Vamos iniciar o acolhimento *Particular (RAF)*.\n\n" +
        "Me conte em uma mensagem:\n" +
        "• Nome e idade de quem será atendido\n" +
        "• Se o atendimento é para você ou para outra pessoa",

    VALORES:
        "Sobre os valores no *Instituto Forja (RAF)*:\n\n" +
        "A avaliação inicial custa *R$ 70,00*. Ela serve para escutar com calma a sua demanda e definir o plano de cuidado mais adequado.\n\n" +
        "Se quiser iniciar a triagem particular, digite *3*; para ver os dias disponíveis, digite *5*; ou digite *menu* para outras opções.",

    HORARIOS:
        "Os horários disponíveis para a avaliação inicial (*R$ 70,00*) são:\n\n" +
        "• *Seg:* 14h, 15h, 16h\n" +
        "• *Ter:* 9h, 10h, 14h\n" +
        "• *Qua:* 14h, 15h, 17h\n" +
        "• *Qui:* 9h, 10h, 15h\n" +
        "• *Sex:* 9h, 14h\n\n" +
        "Digite *3* para iniciar a triagem particular ou *menu* para voltar ao início.",

    NAO_ENTENDI_COM_CONTEXTO: (nome, ultimoAssunto) => {
        const saudacaoNome = nome ? `${nome}, ` : '';
        const gancho = ultimoAssunto
            ? `Como estávamos falando sobre *${ultimoAssunto}*, `
            : '';
        return (
            `${saudacaoNome}${gancho}não tenho certeza se entendi o que você precisa agora.\n\n` +
            "Você pode me explicar de outro jeito, digitar *1* a *5*, pedir *resumo* ou enviar *menu*."
        );
    },

    TRIAGEM_SALVA: (nome) =>
        `Obrigado(a), *${nome}*! Registrei seus dados aqui. Nossa equipe do *Instituto Forja* vai analisar com atenção e dar sequência ao seu atendimento por aqui.\n\n` +
        "Se precisar de algo mais, digite *resumo* para rever ou *menu* para outras opções.",

    MEMORIA_LIMPA:
        "Pronto, apaguei o histórico desta conversa por aqui para começarmos do zero.\n\n" +
        "1 — CRAS (encaminhamento)\n" +
        "2 — SCFV Idosos (60+)\n" +
        "3 — Particular / RAF (avaliação)\n" +
        "4 — Valores\n" +
        "5 — Horários"
};

module.exports = { MENSAGENS };