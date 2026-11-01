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
// CPN1 à CPN4 d'un mois (mois passés consultables) : ?mois=AAAA-MM&province&aire.
router.get('/cpn-mensuel', synthese.cpnMensuel);
// VAT 1 à 5 et SP (TPI) 1 à 3 d'un mois : ?mois=AAAA-MM&province&aire.
router.get('/preventions-mensuel', synthese.preventionsMensuel);
// MILD, micronutriments, mébendazole et conseil DCIP (PTME) d'un mois : ?mois=AAAA-MM&province&aire.
router.get('/prevention-mensuel', synthese.preventionMensuel);

module.exports = router;
