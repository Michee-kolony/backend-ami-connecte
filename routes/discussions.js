const express = require('express');
const { authentifier } = require('../middleware/auth');
const ctrl = require('../controllers/discussions');

const router = express.Router();

// Discussions entre soignants : tout compte soignant actif ; chaque route vérifie la participation.
router.use(authentifier);

// Groupe de pilotage (médecins chefs et comité) : déclaré avant les routes /:id.
const groupe = require('../controllers/groupePilotage');
router.get('/groupe-pilotage', groupe.exigerChef, groupe.resume);
router.get('/groupe-pilotage/messages', groupe.exigerChef, groupe.messages);
router.post('/groupe-pilotage/messages', groupe.exigerChef, groupe.envoyer);
router.post('/groupe-pilotage/lu', groupe.exigerChef, groupe.marquerLu);

router.get('/', ctrl.lister);
router.get('/annuaire', ctrl.annuaire);
router.get('/patientes', ctrl.patientes);
router.post('/', ctrl.ouvrir);
router.get('/:id/messages', ctrl.messages);
router.post('/:id/messages', ctrl.envoyer);
router.post('/:id/lu', ctrl.marquerLu);

module.exports = router;
