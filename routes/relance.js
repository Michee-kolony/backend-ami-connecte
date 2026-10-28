// Relance communautaire, côté personnel : tâches, supervision, comptes RECO, paramétrage,
// tableau de bord. Les droits fins (supervision, paramétrage) sont vérifiés dans les contrôleurs.
const express = require('express');
const { authentifier } = require('../middleware/auth');
const { televerserPhoto } = require('../middleware/upload');
const taches = require('../controllers/relance');
const recos = require('../controllers/recos');
const parametrage = require('../controllers/parametrageRelance');
const indicateurs = require('../controllers/indicateursRelance');

const router = express.Router();
router.use(authentifier);

router.get('/referentiel', taches.referentiel);
router.get('/tableau-de-bord', indicateurs.tableauDeBord);
router.post('/detection', taches.lancerDetection);

router.get('/taches', taches.lister);
router.get('/taches/:numero', taches.obtenir);
router.post('/taches/:numero/attribuer', taches.attribuer);
router.post('/taches/:numero/confirmer', taches.confirmer);
router.post('/taches/:numero/cloturer', taches.cloturer);
router.post('/taches/:numero/rouvrir', taches.rouvrir);
router.post('/taches/:numero/escalader', taches.escalader);
router.post('/taches/:numero/controler', taches.controler);
router.post('/taches/:numero/identifier', taches.identifier);
router.post('/taches/:numero/conflits/:conflitId/resoudre', taches.resoudreConflit);

router.get('/alertes', taches.alertes);
router.post('/alertes/:id/accuser', taches.accuserAlerte);

router.get('/recos', recos.lister);
router.get('/recos/prochain-matricule', recos.prochainMatricule);
// Formulaire multipart : données JSON dans « donnees », photo de profil dans « photo ».
router.post('/recos', televerserPhoto, recos.creer);
router.patch('/recos/:id', televerserPhoto, recos.modifier);
router.patch('/recos/:id/statut', recos.changerStatut);
router.post('/recos/:id/mot-de-passe', recos.reinitialiserMotDePasse);
router.post('/recos/:id/revoquer-sessions', recos.revoquerSessions);

router.get('/parametrage', parametrage.lire);
router.put('/parametrage/parcours/:code', parametrage.modifierParcours);
router.post('/parametrage/parcours/:code/valider', parametrage.validerParcours);
router.post('/parametrage/parcours/:code/suspendre', parametrage.suspendreParcours);
router.put('/parametrage/regles/:code', parametrage.modifierRegle);
router.post('/parametrage/regles/:code/activer', parametrage.activerRegle);
router.post('/parametrage/regles/:code/suspendre', parametrage.suspendreRegle);

module.exports = router;
