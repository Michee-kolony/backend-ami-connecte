const jwt = require('jsonwebtoken');
const Chauffeur = require('../models/Chauffeur');

/**
 * Application chauffeur : vérifie le jeton du chauffeur et le charge dans req.chauffeur.
 * Les jetons du personnel et des patientes sont refusés.
 */
async function authentifierChauffeur(req, res, next) {
  const [type, jeton] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !jeton) return res.status(401).json({ message: 'Authentification requise.' });
  try {
    const { sub, typ } = jwt.verify(jeton, process.env.JWT_SECRET);
    if (typ !== 'chauffeur') return res.status(403).json({ message: 'Espace réservé aux chauffeurs d’ambulance.' });
    const chauffeur = await Chauffeur.findById(sub);
    if (!chauffeur) return res.status(401).json({ message: 'Compte introuvable.' });
    if (chauffeur.statut !== 'Actif') return res.status(401).json({ message: 'Votre compte est suspendu. Contactez la régulation.' });
    req.chauffeur = chauffeur;
    next();
  } catch {
    res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });
  }
}

module.exports = { authentifierChauffeur };
