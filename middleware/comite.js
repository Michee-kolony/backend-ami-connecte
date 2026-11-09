const jwt = require('jsonwebtoken');
const MembreComite = require('../models/MembreComite');

/**
 * Vérifie le jeton d'un membre du comité de pilotage (typ « comite ») et le charge dans
 * req.membreComite. Les indicateurs calculés pour lui couvrent tous les établissements
 * (req.vueGlobale) ; il n'est jamais traité comme un soignant (req.soignant reste vide).
 */
async function authentifierComite(req, res, next) {
  const [type, jeton] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !jeton) return res.status(401).json({ message: 'Authentification requise.' });
  let charge;
  try {
    charge = jwt.verify(jeton, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });
  }
  if (charge.typ !== 'comite') return res.status(403).json({ message: 'Accès réservé au comité de pilotage.' });
  const membre = await MembreComite.findById(charge.sub);
  if (!membre || membre.statut !== 'Actif') return res.status(401).json({ message: 'Compte inactif ou introuvable.' });
  req.membreComite = membre;
  req.vueGlobale = true;
  req.etablissementId = null;
  req.soignant = null;
  next();
}

module.exports = { authentifierComite };
