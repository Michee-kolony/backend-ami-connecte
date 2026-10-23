const express = require('express');
const { authentifier } = require('../middleware/auth');
const { PROVINCES_RDC } = require('../config/referentiels');
const cpn = require('../config/cpn');
const accouchement = require('../config/accouchement');
const partogramme = require('../config/partogramme');
const vaccination = require('../config/vaccination');

const router = express.Router();

router.use(authentifier);

/** Les 26 provinces de la RDC, pour les listes déroulantes du tableau de bord. */
router.get('/provinces', (req, res) => {
  res.json(PROVINCES_RDC);
});

/** Listes de la fiche CPN (antécédents, signes, mesures préventives, laboratoire, référence). */
router.get('/cpn', (req, res) => {
  res.json(cpn);
});

/** Listes du dossier d'accouchement et seuils du partogramme. */
router.get('/accouchement', (req, res) => {
  const { BCF, PHASE_ACTIVE_CM, DILATATION_COMPLETE_CM, VITESSE_CM_H, DECALAGE_ACTION_H, STAGNATION_H } = partogramme;
  res.json({ ...accouchement, partogramme: { BCF, PHASE_ACTIVE_CM, DILATATION_COMPLETE_CM, VITESSE_CM_H, DECALAGE_ACTION_H, STAGNATION_H } });
});

/** Calendrier vaccinal (PEV RDC) et suivi préscolaire. */
router.get('/vaccination', (req, res) => {
  res.json({ calendrier: vaccination.CALENDRIER, types: vaccination.TYPES, toleranceJours: vaccination.TOLERANCE_JOURS });
});

module.exports = router;
