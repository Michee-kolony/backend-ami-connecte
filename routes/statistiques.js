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
// TDR palu d'un mois (réalisés, positifs) : ?mois=AAAA-MM&province&aire.
router.get('/tdr-palu-mensuel', synthese.tdrPaluMensuel);
// Échographies 1, 2 et 3 d'un mois : ?mois=AAAA-MM&province&aire.
router.get('/echographies-mensuel', synthese.echographiesMensuel);
// Module Accouchement d'un mois (20 indicateurs : nombres et taux) : ?mois=AAAA-MM&province&aire.
router.get('/accouchements-mensuel', synthese.accouchementsMensuel);
// Module Nouveau-né et suivi postnatal d'un mois (14 indicateurs) : ?mois=AAAA-MM&province&aire.
router.get('/nouveau-nes-mensuel', synthese.nouveauNesMensuel);
// Module Vaccination d'un mois (28 indicateurs, couverture par antigène) : ?mois=AAAA-MM&province&aire.
router.get('/vaccination-mensuel', synthese.vaccinationMensuel);
// Module communautaire RECO d'un mois (indicateurs transversaux) : ?mois=AAAA-MM&province&aire.
router.get('/reco-mensuel', synthese.recoMensuel);
// Parcours de relance d'un mois (B. RAC, C. ARC, D. RPC, E. IRC, F. TCC) : ?mois=AAAA-MM&province&aire.
router.get('/rac-mensuel', synthese.racMensuel);
router.get('/arc-mensuel', synthese.arcMensuel);
router.get('/rpc-mensuel', synthese.rpcMensuel);
router.get('/irc-mensuel', synthese.ircMensuel);
router.get('/tcc-mensuel', synthese.tccMensuel);

module.exports = router;
