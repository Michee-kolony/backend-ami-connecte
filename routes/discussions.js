const express = require('express');
const { authentifier } = require('../middleware/auth');
const ctrl = require('../controllers/discussions');

const router = express.Router();

// Discussions entre soignants : tout compte soignant actif ; chaque route vérifie la participation.
router.use(authentifier);

router.get('/', ctrl.lister);
router.get('/annuaire', ctrl.annuaire);
router.post('/', ctrl.ouvrir);
router.get('/:id/messages', ctrl.messages);
router.post('/:id/messages', ctrl.envoyer);
router.post('/:id/lu', ctrl.marquerLu);

module.exports = router;
