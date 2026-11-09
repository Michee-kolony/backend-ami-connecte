const express = require('express');
const { authentifierComite } = require('../middleware/comite');
const { televerserPhotosEtablissement } = require('../middleware/upload');
const etablissements = require('../controllers/etablissements');
const statistiques = require('../controllers/statistiques');
const synthese = require('../controllers/synthese');
const ctrl = require('../controllers/comite');

const router = express.Router();

router.post('/connexion', ctrl.connexion);

// Toutes les autres routes : membre du comité de pilotage connecté.
router.use(authentifierComite);

router.get('/moi', ctrl.moi);
router.put('/moi/mot-de-passe', ctrl.changerMotDePasse);

// Établissements sanitaires et leur médecin chef (superadmin de l'établissement).
router.get('/etablissements', ctrl.listerEtablissements);
router.get('/etablissements/:id', etablissements.obtenir);
router.post('/etablissements', televerserPhotosEtablissement, ctrl.creerEtablissement);
router.patch('/etablissements/:id', televerserPhotosEtablissement, etablissements.modifier);
router.patch('/etablissements/:id/statut', etablissements.basculerStatut);
router.delete('/etablissements/:id', ctrl.supprimerEtablissement);
router.post('/etablissements/:id/medecin-chef', ctrl.designerMedecinChef);
router.patch('/etablissements/:id/medecin-chef/:chefId/statut', ctrl.basculerMedecinChef);
router.post('/etablissements/:id/medecin-chef/:chefId/mot-de-passe', ctrl.reinitialiserMedecinChef);

// Personnel soignant de toute la plateforme, avec ses établissements d'affectation (lecture seule).
router.get('/soignants', ctrl.listerSoignants);

// Indicateurs consolidés de tous les établissements (mêmes calculs que le tableau de bord du
// personnel, réponses anonymisées : agrégats seulement).
const s = ctrl.statistiques;
router.get('/statistiques/etablissements', ctrl.parEtablissement);
router.get('/statistiques/patientes', s(statistiques.patientes));
router.get('/statistiques/enfants', s(statistiques.enfants));
router.get('/statistiques/synthese', s(synthese.synthese));
for (const route of [
  'cpn-mensuel', 'preventions-mensuel', 'prevention-mensuel', 'tdr-palu-mensuel', 'echographies-mensuel',
  'accouchements-mensuel', 'nouveau-nes-mensuel', 'vaccination-mensuel', 'reco-mensuel',
  'rac-mensuel', 'arc-mensuel', 'rpc-mensuel', 'irc-mensuel', 'tcc-mensuel',
]) {
  const nom = route.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (synthese[nom]) router.get(`/statistiques/${route}`, s(synthese[nom]));
}

module.exports = router;
