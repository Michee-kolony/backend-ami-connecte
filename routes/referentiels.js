const express = require('express');
const { authentifier } = require('../middleware/auth');
const { PROVINCES_RDC } = require('../config/referentiels');
const cpn = require('../config/cpn');

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

module.exports = router;
