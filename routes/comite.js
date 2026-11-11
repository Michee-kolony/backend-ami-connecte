const express = require('express');
const { authentifierComite } = require('../middleware/comite');
const { televerserPhoto, televerserPhotosEtablissement } = require('../middleware/upload');
const etablissements = require('../controllers/etablissements');
const statistiques = require('../controllers/statistiques');
const synthese = require('../controllers/synthese');
const ctrl = require('../controllers/comite');

const router = express.Router();

router.post('/connexion', ctrl.connexion);

// Toutes les autres routes : membre du comité de pilotage connecté.
router.use(authentifierComite);

router.get('/moi', ctrl.moi);
router.patch('/moi', televerserPhoto, ctrl.modifierProfil);
router.put('/moi/mot-de-passe', ctrl.changerMotDePasse);

// Membres du comité : chacun peut consulter la liste et ajouter un nouveau membre.
router.get('/membres', ctrl.listerMembres);
router.post('/membres', ctrl.ajouterMembre);
// Seul le président du comité peut retirer un membre (vérifié par le contrôleur).
router.delete('/membres/:id', ctrl.supprimerMembre);

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
// Messagerie : discussions privées avec les médecins chefs, et groupe de pilotage commun.
const discussions = require('../controllers/discussions');
const groupe = require('../controllers/groupePilotage');
router.get('/discussions', discussions.listerComite);
router.get('/discussions/annuaire', discussions.annuaireComite);
router.post('/discussions', discussions.ouvrirComite);
router.get('/discussions/:id/messages', discussions.messages);
router.post('/discussions/:id/messages', discussions.envoyer);
router.post('/discussions/:id/lu', discussions.marquerLu);
router.get('/groupe-pilotage', groupe.resume);
router.get('/groupe-pilotage/messages', groupe.messages);
router.post('/groupe-pilotage/messages', groupe.envoyer);
router.post('/groupe-pilotage/lu', groupe.marquerLu);

// Patientes de toute la plateforme : identité et enfants seulement (aucune donnée médicale).
router.get('/patientes', ctrl.listerPatientes);

// Relais communautaires (RECO) de toute la plateforme (lecture seule).
router.get('/recos', ctrl.listerRecos);
// Ambulances et chauffeurs de toute la plateforme, avec leur établissement (lecture seule).
router.get('/flotte', ctrl.listerFlotte);

// Indicateurs consolidés de tous les établissements (mêmes calculs que le tableau de bord du
// personnel, réponses anonymisées : agrégats seulement).
const s = ctrl.statistiques;
// Filtre commun à tous les indicateurs : établissement, province ou zone de santé.
router.use('/statistiques', ctrl.lirePerimetre);
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
