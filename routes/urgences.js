// Urgences (régulation) : alertes de détresse des patientes, envoi d'un chauffeur et d'une
// ambulance, clôture. Tout le personnel connecté peut réguler.
const express = require('express');
const { authentifier } = require('../middleware/auth');
const ctrl = require('../controllers/urgences');
const messages = require('../controllers/messagesUrgence');

const router = express.Router();
router.use(authentifier);

router.get('/', ctrl.lister);
router.get('/:numero', ctrl.obtenir);
router.post('/:numero/prise-en-charge', ctrl.prendreEnCharge);
router.post('/:numero/affectation', ctrl.affecter);
router.post('/:numero/cloture', ctrl.cloturer);
router.post('/:numero/annulation', ctrl.annuler);
// Chat de l'urgence (patiente, chauffeur et régulation)
router.get('/:numero/messages', messages.lister);
router.post('/:numero/messages', messages.envoyer);

module.exports = router;
