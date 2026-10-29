const express = require('express');
const { authentifier } = require('../middleware/auth');
const ctrl = require('../controllers/statistiques');
const synthese = require('../controllers/synthese');

const router = express.Router();

// Indicateurs agrégés du tableau de bord : tout le personnel soignant connecté.
router.use(authentifier);

router.get('/patientes', ctrl.patientes);
router.get('/enfants', ctrl.enfants);
// Synthèse opérationnelle (cahier du tableau de bord) : filtres ?periode=jour|7j|mois|trimestre|annee|perso&du&au&province&aire.
router.get('/synthese', synthese.synthese);

module.exports = router;
