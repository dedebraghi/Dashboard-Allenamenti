// Vercel Serverless Function: /api/generate-plan
// Elabora la sessione balistica con Google Gemini AI e salva il nuovo piano in background

const GEMINI_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
const FIREBASE_PROJECT_ID = 'dashboard-allenamenti';

async function callGemini(payload, apiKey) {
    for (const model of GEMINI_MODELS) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const data = await res.json();
                return { ok: true, data, modelUsed: model };
            }
            console.warn(`[Gemini Serverless] Modello ${model} status ${res.status}`);
        } catch (e) {
            console.warn(`[Gemini Serverless] Errore con ${model}:`, e.message);
        }
    }
    return { ok: false, error: 'Nessun modello Gemini raggiungibile' };
}

function toFirestoreValue(val) {
    if (val === null || val === undefined) return { nullValue: null };
    if (typeof val === 'boolean') return { booleanValue: val };
    if (typeof val === 'number') {
        return Number.isInteger(val) ? { integerValue: val.toString() } : { doubleValue: val };
    }
    if (typeof val === 'string') return { stringValue: val };
    if (Array.isArray(val)) {
        return { arrayValue: { values: val.map(toFirestoreValue) } };
    }
    if (typeof val === 'object') {
        const fields = {};
        for (const [k, v] of Object.entries(val)) {
            fields[k] = toFirestoreValue(v);
        }
        return { mapValue: { fields } };
    }
    return { stringValue: String(val) };
}

async function saveToFirestoreRest(collection, docId, data, apiKey) {
    try {
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;
        const fields = {};
        for (const [k, v] of Object.entries(data)) {
            fields[k] = toFirestoreValue(v);
        }

        const res = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
        });

        if (res.ok) {
            console.log(`[Firestore REST] Salvato con successo ${collection}/${docId}`);
            return true;
        } else {
            const err = await res.text();
            console.warn(`[Firestore REST] Errore salvataggio ${collection}/${docId}:`, err);
            return false;
        }
    } catch (e) {
        console.warn(`[Firestore REST] Eccezione scrittura:`, e);
        return false;
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { sessionData, playerNotes, sessionsHistory, geminiKey, firebaseApiKey } = req.body || {};

        if (!sessionData) {
            return res.status(400).json({ error: 'Missing sessionData payload' });
        }

        const apiKey = geminiKey || process.env.GEMINI_API_KEY || (typeof Buffer !== 'undefined' ? Buffer.from('QVEuQWI4Uk42SWlKZDdMR0xzVVRzRzJscWxpYlBpR1RUSW54WXhoX29XZjJ6NE5zcDBVa3c=', 'base64').toString('utf-8') : '');
        const fbApiKey = firebaseApiKey || process.env.FIREBASE_API_KEY || (typeof Buffer !== 'undefined' ? Buffer.from('QUl6YVN5RDdDVkFyRGpDS1NkdE9tc2hEYTNSQjl1OHlzZW5OWlRv', 'base64').toString('utf-8') : '');

        const historyList = Array.isArray(sessionsHistory) ? sessionsHistory : [];

        // Calcolo Medie Globali Storico Carriera
        let total3Made = 0, total3Att = 0;
        let totalFtMade = 0, totalFtAtt = 0;
        let totalPatMade = 0, totalPatAtt = 0;
        const spotTotals = {
            angoloSX: { made: 0, att: 0 },
            guardiaSX: { made: 0, att: 0 },
            punta: { made: 0, att: 0 },
            guardiaDX: { made: 0, att: 0 },
            angoloDX: { made: 0, att: 0 },
            gomitoSX: { made: 0, att: 0 },
            gomitoDX: { made: 0, att: 0 }
        };

        historyList.forEach(s => {
            if (s.tri) {
                ['angoloSX', 'guardiaSX', 'punta', 'guardiaDX', 'angoloDX'].forEach(k => {
                    const sp = s.tri[k];
                    if (sp && sp.att > 0) {
                        spotTotals[k].made += (sp.made || 0);
                        spotTotals[k].att += sp.att;
                        total3Made += (sp.made || 0);
                        total3Att += sp.att;
                    }
                });
            }
            if (s.pat) {
                ['gomitoSX', 'gomitoDX'].forEach(k => {
                    const sp = s.pat[k];
                    if (sp && sp.att > 0) {
                        spotTotals[k].made += (sp.made || 0);
                        spotTotals[k].att += sp.att;
                        totalPatMade += (sp.made || 0);
                        totalPatAtt += sp.att;
                    }
                });
            }
            if (s.liberi && s.liberi.att > 0) {
                totalFtMade += (s.liberi.made || 0);
                totalFtAtt += s.liberi.att;
            }
        });

        const globalAverages = {
            sessioniTotali: historyList.length,
            tiroDa3Totale: `${total3Made}/${total3Att} (${total3Att > 0 ? Math.round((total3Made/total3Att)*100) : 0}%)`,
            dettaglio3PuntiPerSpot: {
                angoloSX: `${spotTotals.angoloSX.made}/${spotTotals.angoloSX.att} (${spotTotals.angoloSX.att > 0 ? Math.round((spotTotals.angoloSX.made/spotTotals.angoloSX.att)*100) : 0}%)`,
                guardiaSX: `${spotTotals.guardiaSX.made}/${spotTotals.guardiaSX.att} (${spotTotals.guardiaSX.att > 0 ? Math.round((spotTotals.guardiaSX.made/spotTotals.guardiaSX.att)*100) : 0}%)`,
                punta: `${spotTotals.punta.made}/${spotTotals.punta.att} (${spotTotals.punta.att > 0 ? Math.round((spotTotals.punta.made/spotTotals.punta.att)*100) : 0}%)`,
                guardiaDX: `${spotTotals.guardiaDX.made}/${spotTotals.guardiaDX.att} (${spotTotals.guardiaDX.att > 0 ? Math.round((spotTotals.guardiaDX.made/spotTotals.guardiaDX.att)*100) : 0}%)`,
                angoloDX: `${spotTotals.angoloDX.made}/${spotTotals.angoloDX.att} (${spotTotals.angoloDX.att > 0 ? Math.round((spotTotals.angoloDX.made/spotTotals.angoloDX.att)*100) : 0}%)`
            },
            patTotale: `${totalPatMade}/${totalPatAtt} (${totalPatAtt > 0 ? Math.round((totalPatMade/totalPatAtt)*100) : 0}%)`,
            dettaglioPATPerGomito: {
                gomitoSX: `${spotTotals.gomitoSX.made}/${spotTotals.gomitoSX.att} (${spotTotals.gomitoSX.att > 0 ? Math.round((spotTotals.gomitoSX.made/spotTotals.gomitoSX.att)*100) : 0}%)`,
                gomitoDX: `${spotTotals.gomitoDX.made}/${spotTotals.gomitoDX.att} (${spotTotals.gomitoDX.att > 0 ? Math.round((spotTotals.gomitoDX.made/spotTotals.gomitoDX.att)*100) : 0}%)`
            },
            tiriLiberiTotale: `${totalFtMade}/${totalFtAtt} (${totalFtAtt > 0 ? Math.round((totalFtMade/totalFtAtt)*100) : 0}%)`
        };

        let histOverview = `Storico giocatore su ${historyList.length} sessioni registrate:\n`;
        historyList.slice(0, 5).forEach((s) => {
            const s3 = s.tri?.angoloSX?.att > 0 ? `${s.tri.angoloSX.made + s.tri.guardiaSX.made + s.tri.punta.made + s.tri.guardiaDX.made + s.tri.angoloDX.made}/${s.tri.angoloSX.att + s.tri.guardiaSX.att + s.tri.punta.att + s.tri.guardiaDX.att + s.tri.angoloDX.att}` : 'N/D';
            histOverview += `- Sessione ${s.date}: 3PT ${s3}, Liberi ${s.liberi?.made || 0}/${s.liberi?.att || 0}, PAT Gomito SX ${s.pat?.gomitoSX?.made || 0}/${s.pat?.gomitoSX?.att || 0}, Gomito DX ${s.pat?.gomitoDX?.made || 0}/${s.pat?.gomitoDX?.att || 0}\n`;
        });

        const currentNumbers = JSON.stringify({
            data: sessionData.date,
            durataMinuti: sessionData.duration,
            tiroDa3: sessionData.tri,
            palleggioArrestoTiro: sessionData.pat,
            tiriLiberi: sessionData.liberi,
            formShooting: sessionData.formShooting,
            noteAtleta: playerNotes || sessionData.noteAtleta || ''
        }, null, 2);

        const globalAveragesJson = JSON.stringify(globalAverages, null, 2);

        const completedSessionsCount = historyList.length;
        const currentSessionNumber = completedSessionsCount;
        const nextPlanNumber = completedSessionsCount + 1;
        const nextSessionNumber = currentSessionNumber;

        const systemInstruction = `
Sei l'AI Shooting Coach d'élite di Davide Braghiroli (ShotTracker Analytics).
Il tuo compito fondamentale è:
1) Analizzare accuratamente la sessione di tiro odierna (Sessione #${nextSessionNumber} del ${sessionData.date}) confrontandola puntualmente con la MEDIA GLOBALE STORICA del giocatore e il trend cronologico.
2) ESPRIMERE UN GIUDIZIO TECNICO ED ELOQUENTE SULL'IDENTIKIT BALISTICO DELL'ATLETA:
   - Raccontare l'essenza del giocatore attraverso i dati, evidenziando solidità, ritmo di rilascio, asimmetrie (es. lato sinistro vs destro) e tenuta mentale sotto sforzo.
   - Valutare la prestazione odierna rispetto alla media carriera (spot sopra/sotto media, progressione o regressione biomeccanica).
3) USARE QUESTI GIUDIZI SULLA MEDIA PER COSTRUIRE IL NUOVO ALLENAMENTO ("nextPlan" #${nextPlanNumber}):
   - Progetta la nuova scheda calibrandola direttamente sulle debolezze strutturali della media (es. sovraccarico mirato su spot deboli o modifiche alle serie) e consolidando le certezze.
   - Sei libero di variare le regole operative, i protocolli cardio, le combinazioni di tiro, il numero di serie e i focus biomeccanici specifici per stimolare l'adattamento dell'atleta.
4) IMPORTANTE: Includere sia le 5 fasi descrittive ("phases") per l'atleta, sia l'oggetto strutturato "drills" con l'elenco esatto di serie e tentativi (att) per ogni spot e fase, in modo che la scheda Workout Live interattiva possa renderizzare 1:1 esattamente ogni tiro prescritto.

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido (senza markdown aggiuntivo) che rispetti rigorosamente questo schema:
{
  "insight": {
    "title": "Analisi Puntuale Sessione #${nextSessionNumber} (${sessionData.date}) • Confronto con Media Storica",
    "summary": "Paragrafo descrittivo approfondito ed eloquente che racconta l'essenza del giocatore e la resa di oggi a confronto con la media storica.",
    "sections": [
      { "heading": "Tiro da 3 Punti (XX% Oggi vs XX% Media Globale)", "content": "Giudizio balistico dettagliato per spot, parabola e rilascio a confronto con la media..." },
      { "heading": "Palleggio Arresto e Tiro - P.A.T. (XX% Oggi vs XX% Media Globale)", "content": "Analisi footwork, perno sui gomiti e confronto con la media..." },
      { "heading": "Tiri Liberi & Tenuta Sotto Sforzo (XX% Oggi vs XX% Media Globale)", "content": "Analisi tenuta in apnea e confronto con la media..." }
    ]
  },
  "nextPlan": {
    "id": "piano-${nextPlanNumber}",
    "number": ${nextPlanNumber},
    "title": "Programma di Allenamento Analitico • Scheda per Allenamento #${nextPlanNumber}",
    "description": "Descrizione tecnica dettagliata dell'obiettivo della scheda adattata.",
    "drills": {
      "formShooting": [
        { "spot": "Ravvicinato Pos. 1", "att": 10 },
        { "spot": "Ravvicinato Pos. 2", "att": 10 },
        { "spot": "Ravvicinato Pos. 3", "att": 10 }
      ],
      "attivazioneLiberi": [
        { "spot": "Lunetta Attivazione", "att": 10 }
      ],
      "tri": {
        "angoloSX": [{ "att": 10 }, { "att": 10 }],
        "guardiaSX": [{ "att": 5 }, { "att": 5 }],
        "punta": [{ "att": 5 }, { "att": 5 }],
        "guardiaDX": [{ "att": 10 }, { "att": 10 }],
        "angoloDX": [{ "att": 10 }, { "att": 10 }]
      },
      "pat": {
        "gomitoSX": [{ "att": 5 }, { "att": 5 }, { "att": 5 }],
        "gomitoDX": [{ "att": 5 }, { "att": 5 }, { "att": 5 }]
      },
      "faticaLiberi": {
        "cycles": 10,
        "shotsPerCycle": 2,
        "series": [
          { "att": 2 }, { "att": 2 }, { "att": 2 }, { "att": 2 }, { "att": 2 },
          { "att": 2 }, { "att": 2 }, { "att": 2 }, { "att": 2 }, { "att": 2 }
        ]
      }
    },
    "phases": [
      {
        "id": "fase-1",
        "name": "Fase 1: Attivazione & Sensibilità",
        "time": "0 - 10 min",
        "objective": "Obiettivo...",
        "focus": "Focus biomeccanico...",
        "badgeColor": "blue",
        "details": {
          "description": "Dettaglio operativo...",
          "bullets": ["Indicazione 1...", "Indicazione 2..."]
        }
      },
      {
        "id": "fase-2",
        "name": "Fase 2: Compensazione (Tiro da 3)",
        "time": "10 - 30 min",
        "objective": "Obiettivo...",
        "focus": "Focus...",
        "badgeColor": "indigo",
        "details": {
          "description": "Dettaglio...",
          "table": [
            { "spot": "Angolo Sinistro", "volume": "10 tiri (x2 giri = 20)", "focus": "...", "highlight": true },
            { "spot": "Guardia Sinistra", "volume": "5 tiri (x2 giri = 10)", "focus": "...", "highlight": false },
            { "spot": "Punta", "volume": "5 tiri (x2 giri = 10)", "focus": "...", "highlight": false },
            { "spot": "Guardia Destra", "volume": "10 tiri (x2 giri = 20)", "focus": "...", "highlight": true },
            { "spot": "Angolo Destro", "volume": "10 tiri (x2 giri = 20)", "focus": "...", "highlight": true }
          ],
          "rule": "💡 Regola Operativa: ..."
        }
      },
      {
        "id": "fase-3",
        "name": "Fase 3: Footwork (P.A.T.)",
        "time": "30 - 45 min",
        "objective": "Obiettivo...",
        "focus": "Focus...",
        "badgeColor": "amber",
        "details": {
          "description": "Dettaglio...",
          "split": [
            { "title": "1ª Metà: Guardia SX → Gomito SX (15 Tiri: 3 serie x 5 ripetizioni)", "text": "..." },
            { "title": "2ª Metà: Guardia DX → Gomito DX (15 Tiri: 3 serie x 5 ripetizioni)", "text": "..." }
          ]
        }
      },
      {
        "id": "fase-4",
        "name": "Fase 4: Fatica & Resilienza (Tiri Liberi)",
        "time": "45 - 55 min",
        "objective": "Obiettivo...",
        "focus": "Focus...",
        "badgeColor": "emerald",
        "details": {
          "description": "Dettaglio...",
          "protocolTitle": "Protocollo Sotto Sforzo (10 cicli = 20 tiri liberi totali):",
          "steps": ["Step 1...", "Step 2..."],
          "note": "Obiettivo Tecnico: ..."
        }
      },
      {
        "id": "fase-5",
        "name": "Fase 5: Defaticamento & Visualizzazione",
        "time": "55 - 60 min",
        "objective": "Decompressione e pattern motori",
        "focus": "Visualizzazione e stretching",
        "badgeColor": "slate",
        "details": {
          "description": "Allungamento e visualizzazione retina...",
          "note": "Visualizzazione della Parabola..."
        }
      }
    ]
  }
}
`;

        const aiResult = await callGemini({
            contents: [
                {
                    parts: [
                        { text: systemInstruction },
                        { text: `DATI SESSIONE ODIERNA:\n${currentNumbers}\n\nMEDIE GLOBALI STORICHE CARRIERA:\n${globalAveragesJson}\n\nULTIMI ALLENAMENTI REGISTRATI:\n${histOverview}` }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json"
            }
        }, apiKey);

        if (!aiResult.ok) {
            throw new Error(aiResult.error);
        }

        const apiJson = aiResult.data;
        const aiRawText = apiJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!aiRawText) throw new Error("Risposta AI vuota");

        let parsedAi;
        try {
            parsedAi = JSON.parse(aiRawText);
        } catch (e) {
            const cleanJson = aiRawText.replace(/^\`\`\`json/m, '').replace(/\`\`\`$/m, '').trim();
            parsedAi = JSON.parse(cleanJson);
        }

        sessionData.aiStatus = 'completed';
        if (parsedAi.insight) sessionData.insight = parsedAi.insight;

        await saveToFirestoreRest('sessions', sessionData.id, sessionData, fbApiKey);
        if (parsedAi.nextPlan) {
            await saveToFirestoreRest('plans', parsedAi.nextPlan.id, parsedAi.nextPlan, fbApiKey);
        }

        return res.status(200).json({
            ok: true,
            modelUsed: aiResult.modelUsed,
            insight: parsedAi.insight,
            nextPlan: parsedAi.nextPlan
        });

    } catch (err) {
        console.error('[Serverless Handler Error]', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};
