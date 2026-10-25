// Dossier de l'enfant : carnet vaccinal, croissance et rendez-vous ouverts à tout le personnel
// soignant (la vaccination est souvent faite par les infirmier·ères) ; les données de naissance
// ne sont modifiables que par les médecins et les sages-femmes (contrôlé dans le contrôleur).
const express = require('express');
const { authentifier } = require('../middleware/auth');
const { televerserPhoto, televerserPhotosEnfantEtMere } = require('../middleware/upload');
const ctrl = require('../controllers/enfants');
const rendezVous = require('../controllers/rendezVous');

const router = express.Router();
router.use(authentifier);

router.get('/', ctrl.rechercher);
// Enfant né hors plateforme (ni CPN ni accouchement ici) enregistré pour sa vaccination : multipart,
// données JSON dans « donnees », photo de l'enfant dans « photo », de la nouvelle mère dans « photoMere ».
router.post('/', televerserPhotosEnfantEtMere, ctrl.enregistrer);
router.get('/:id', ctrl.obtenir);
router.patch('/:id', ctrl.modifier);
router.put('/:id/photo', televerserPhoto, ctrl.changerPhoto);
router.post('/:id/vaccinations', ctrl.vacciner);
router.post('/:id/vaccinations/:vaccinationId/annuler', ctrl.annulerVaccination);
router.post('/:id/suivis', ctrl.ajouterSuivi);
router.get('/:id/rendez-vous', ctrl.listerRendezVous);
router.post('/:id/rendez-vous', ctrl.creerRendezVous);
router.patch('/:enfantId/rendez-vous/:id', ctrl.verifierRendezVousEnfant, rendezVous.modifier);

module.exports = router;
