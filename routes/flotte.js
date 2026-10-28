// Flotte de secours : ambulances et chauffeurs. Lecture : tout le personnel ;
// ajout et modification : médecins (administration des secours).
const express = require('express');
const { authentifier, exigerRole } = require('../middleware/auth');
const { televerserPhoto } = require('../middleware/upload');
const { ROLES_MEDECIN } = require('../models/Soignant');
const ctrl = require('../controllers/flotte');

const router = express.Router();
router.use(authentifier);
const gestion = exigerRole(...ROLES_MEDECIN);

router.get('/ambulances', ctrl.listerAmbulances);
router.post('/ambulances', gestion, ctrl.creerAmbulance);
router.patch('/ambulances/:code', gestion, ctrl.modifierAmbulance);

router.get('/chauffeurs', ctrl.listerChauffeurs);
router.get('/chauffeurs/:id', ctrl.obtenirChauffeur);
// Formulaire multipart : données JSON dans « donnees », photo de profil dans « photo ».
router.post('/chauffeurs', gestion, televerserPhoto, ctrl.creerChauffeur);
router.patch('/chauffeurs/:id', gestion, televerserPhoto, ctrl.modifierChauffeur);
router.patch('/chauffeurs/:id/statut', gestion, ctrl.changerStatutChauffeur);
router.post('/chauffeurs/:id/mot-de-passe', gestion, ctrl.reinitialiserMotDePasse);
router.get('/chauffeurs/:id/carte-service', ctrl.carteService);

module.exports = router;
