const OperationTraitee = require('../models/OperationTraitee');

const OPERATION = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * Saisies de l'espace administrateur faites hors connexion : chaque écriture porte un
 * identifiant unique (en-tête X-Operation-Id). Une opération déjà réussie n'est jamais rejouée :
 * sa réponse enregistrée est renvoyée. Une opération en échec (4xx, 5xx) peut être retentée.
 */
async function idempotence(req, res, next) {
  const operationId = req.get('X-Operation-Id');
  if (!operationId || req.method === 'GET' || !OPERATION.test(operationId)) return next();

  const existante = await OperationTraitee.findOne({ operationId }).lean();
  if (existante?.statut === 'terminée') {
    res.set('X-Operation-Rejouee', 'oui');
    return res.status(existante.codeHttp).json(existante.corps);
  }
  if (existante) return res.status(409).json({ message: 'Cette saisie est déjà en cours d’envoi. Patientez un instant.' });
  try {
    await OperationTraitee.create({ operationId, methode: req.method, route: req.originalUrl.split('?')[0] });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Cette saisie est déjà en cours d’envoi. Patientez un instant.' });
    throw err;
  }

  // Réponse réussie gardée ; en cas d'échec, l'opération est oubliée (nouvelle tentative possible).
  const json = res.json.bind(res);
  res.json = (corps) => {
    const code = res.statusCode;
    // Réponse gardée telle qu'envoyée (sérialisée : `id` et non `_id` des documents Mongoose),
    // pour que le rejeu renvoie exactement le même corps.
    const fin = code < 400
      ? OperationTraitee.updateOne({ operationId }, { statut: 'terminée', codeHttp: code, corps: corps === undefined ? null : JSON.parse(JSON.stringify(corps)) })
      : OperationTraitee.deleteOne({ operationId });
    fin.catch((err) => console.error('Opération hors ligne : enregistrement impossible :', err.message));
    return json(corps);
  };
  res.on('close', () => {
    if (!res.writableEnded) OperationTraitee.deleteOne({ operationId, statut: 'en cours' }).catch(() => {});
  });
  next();
}

module.exports = { idempotence };
