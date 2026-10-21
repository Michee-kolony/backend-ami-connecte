const express = require('express');
const { authentifier, exigerRole } = require('../middleware/auth');
const { televerserPhotosEtablissement } = require('../middleware/upload');
const { ROLES_GESTION } = require('../models/Soignant');
const ctrl = require('../controllers/etablissements');

const router = express.Router();

router.use(authentifier);

router.get('/', ctrl.lister);
router.get('/:id', ctrl.obtenir);
router.post('/', exigerRole(...ROLES_GESTION), televerserPhotosEtablissement, ctrl.creer);
router.patch('/:id', exigerRole(...ROLES_GESTION), televerserPhotosEtablissement, ctrl.modifier);
router.patch('/:id/statut', exigerRole(...ROLES_GESTION), ctrl.basculerStatut);
router.delete('/:id', exigerRole(...ROLES_GESTION), ctrl.supprimer);

module.exports = router;
