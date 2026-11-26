const fs = require('fs');
const path = require('path');
const {
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');
const { admin, getDb } = require('./firebase');

const COLECAO_AUTH = 'whatsapp_auth';
const DOC_CREDS = 'creds';
const DOC_KEYS = 'keys';

function docIdChave(tipo, id) {
    return `${tipo}__${id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function serializar(obj) {
    return JSON.stringify(obj, BufferJSON.replacer);
}

function desserializar(str) {
    if (!str) return null;
    return JSON.parse(str, BufferJSON.reviver);
}

function garantirPastaLocal(dirPath) {
    if (dirPath && !fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function salvarCredsLocal(dirPath, creds) {
    if (!dirPath) return;
    try {
        garantirPastaLocal(dirPath);
        fs.writeFileSync(path.join(dirPath, 'creds.json'), serializar(creds), 'utf8');
    } catch (_) {}
}

function lerCredsLocal(dirPath) {
    if (!dirPath) return null;
    try {
        const arquivo = path.join(dirPath, 'creds.json');
        if (!fs.existsSync(arquivo)) return null;
        return desserializar(fs.readFileSync(arquivo, 'utf8'));
    } catch (_) {
        return null;
    }
}

async function useFirestoreAuthState(localBackupDir = null) {
    const db = getDb();
    let creds = null;

    if (db) {
        try {
            const snap = await db.collection(COLECAO_AUTH).doc(DOC_CREDS).get();
            if (snap.exists && snap.data()?.payload) {
                creds = desserializar(snap.data().payload);
            }
        } catch (e) {
            console.error('Erro ao ler creds do Firestore:', e.message);
        }
    }

    if (!creds) {
        creds = lerCredsLocal(localBackupDir);
    }

    if (!creds) {
        creds = initAuthCreds();
    }

    const saveCreds = async (novasCreds) => {
        const atual = novasCreds || creds;
        creds = atual;
        salvarCredsLocal(localBackupDir, atual);

        const client = getDb();
        if (!client) return;
        try {
            await client.collection(COLECAO_AUTH).doc(DOC_CREDS).set(
                {
                    payload: serializar(atual),
                    atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
                },
                { merge: true }
            );
        } catch (e) {
            console.error('Erro ao salvar creds no Firestore:', e.message);
        }
    };

    const keys = {
        get: async (type, ids) => {
            const resultado = {};
            const client = getDb();
            if (!client || !Array.isArray(ids) || ids.length === 0) return resultado;

            try {
                const refs = ids.map((id) => client.collection(DOC_KEYS).doc(docIdChave(type, id)));
                const snaps = await client.getAll(...refs);

                snaps.forEach((snap, idx) => {
                    const id = ids[idx];
                    if (snap.exists && snap.data()?.payload) {
                        let valor = desserializar(snap.data().payload);
                        if (type === 'app-state-sync-key' && valor) {
                            valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
                        }
                        resultado[id] = valor;
                    }
                });
            } catch (e) {
                console.error(`Erro ao ler chaves (${type}) no Firestore:`, e.message);
            }

            return resultado;
        },

        set: async (data) => {
            const client = getDb();
            if (!client || !data || typeof data !== 'object') return;

            try {
                const batch = client.batch();
                let operacoes = 0;

                for (const [type, idsMap] of Object.entries(data)) {
                    for (const [id, valor] of Object.entries(idsMap || {})) {
                        const ref = client.collection(DOC_KEYS).doc(docIdChave(type, id));
                        if (valor) {
                            batch.set(ref, {
                                payload: serializar(valor),
                                atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
                            });
                        } else {
                            batch.delete(ref);
                        }
                        operacoes++;
                    }
                }

                if (operacoes > 0) {
                    await batch.commit();
                }
            } catch (e) {
                console.error('Erro ao salvar chaves no Firestore:', e.message);
            }
        }
    };

    return {
        state: { creds, keys },
        saveCreds
    };
}

async function limparSessaoFirestore(localBackupDir = null) {
    const db = getDb();
    if (db) {
        try {
            await db.collection(COLECAO_AUTH).doc(DOC_CREDS).delete();
            const snapKeys = await db.collection(DOC_KEYS).limit(400).get();
            if (!snapKeys.empty) {
                const batch = db.batch();
                snapKeys.docs.forEach((doc) => batch.delete(doc.ref));
                await batch.commit();
            }
        } catch (e) {
            console.error('Erro ao limpar sessão no Firestore:', e.message);
        }
    }

    if (localBackupDir && fs.existsSync(localBackupDir)) {
        try {
            fs.rmSync(localBackupDir, { recursive: true, force: true });
        } catch (_) {}
    }
}

module.exports = {
    useFirestoreAuthState,
    limparSessaoFirestore
};