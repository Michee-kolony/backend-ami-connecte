const jwt = require('jsonwebtoken');
const Reco = require('../models/Reco');

/**
 * Application RECO : vérifie le jeton du relais communautaire et le charge dans req.reco.
 * Les jetons du personnel, des patientes et des chauffeurs sont refusés, comme ceux émis avant
 * une révocation (téléphone perdu ou compromis).
 */
async function authentifierReco(req, res, next) {
  const [type, jeton] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !jeton) return res.status(401).json({ message: 'Authentification requise.' });
  try {
    const { sub, typ, iat } = jwt.verify(jeton, process.env.JWT_SECRET);
    if (typ !== 'reco') return res.status(403).json({ message: 'Espace réservé aux relais communautaires.' });
    const reco = await Reco.findById(sub);
    if (!reco) return res.status(401).json({ message: 'Compte introuvable.' });
    if (reco.statut !== 'Actif') return res.status(401).json({ message: 'Votre compte est suspendu. Contactez votre superviseur.' });
    if (reco.sessionsRevoqueesLe && iat * 1000 < reco.sessionsRevoqueesLe.getTime()) {
      return res.status(401).json({ message: 'Session révoquée, reconnectez-vous.' });
    }
    req.reco = reco;
    next();
  } catch {
    res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });
  }
}

module.exports = { authentifierReco };
