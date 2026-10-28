// Indicateurs et tableau de bord de la relance (sections 9 et 13). Données agrégées seulement :
// aucune liste nominative. Règles de calcul :
//   - la cohorte est l'ensemble des tâches créées dans la période (filtres : parcours, domaine,
//     aire de santé, RECO), hors doublons annulés ;
//   - les taux « personnes » comptent des personnes uniques (une personne relancée deux fois
//     compte une fois), les taux « tâches » comptent des tâches : les deux ne sont jamais mélangés ;
//   - la réintégration n'est comptée qu'après confirmation (dossier de soins ou structure) ;
//   - chaque parcours (RAC, ARC, RPC, IRC, TCC) est calculé séparément.
// Ces indicateurs transversaux sont des exemples techniques : les taux officiels de chaque
// parcours suivent la formule validée dans sa fiche de paramétrage.
const mongoose = require('mongoose');
const TacheRelance = require('../models/TacheRelance');
const Patiente = require('../models/Patiente');
const Enfant = require('../models/Enfant');
const Reco = require('../models/Reco');
const ParcoursRelance = require('../models/ParcoursRelance');
const { journaliser } = require('../config/audit');
const { jourKinshasa } = require('../config/vaccination');
const r = require('../config/relance');
const { estSuperviseur, filtreTerritoire } = require('./relance');
const { erreur, texte, jour } = require('./saisie');

const FINAUX_VALIDES = ['Réintégration confirmée', 'Clôturée sans réintégration'];
const personne = (t) => `${t.personneType}:${String(t.enfantId ?? t.patienteId ?? t.numero)}`;
const unique = (taches) => new Set(taches.map(personne));
const taux = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);

/** Indicateur avec son numérateur, son dénominateur et sa formule (vérifiable). */
const indicateur = (code, libelle, unite, numerateur, denominateur, formule) => ({
  code, libelle, unite, numerateur, denominateur, valeur: taux(numerateur, denominateur), formule,
});

function calculer(taches, maintenant) {
  const valides = taches.filter((t) => t.statut !== 'Doublon annulé');
  const confiees = valides.filter((t) => t.attribueeLe);
  const pConfiees = unique(confiees);
  const pContactees = unique(confiees.filter((t) => t.contactEtabliLe));
  const visitesEchues = valides.flatMap((t) => t.visites).filter((v) => v.prevueLe <= maintenant);
  const pEligibles = unique(valides);
  const pReintegrees = unique(valides.filter((t) => t.statut === 'Réintégration confirmée'));
  const echues = valides.filter((t) => t.echeance <= maintenant);
  const resolues = valides.filter((t) => FINAUX_VALIDES.includes(t.statut));
  const ouvertes = valides.filter((t) => t.ouverte);
  const enRetard = ouvertes.filter((t) => t.echeance < maintenant);
  const pTentees = unique(valides.filter((t) => t.actions.some((a) => ['tentative', 'visite_realisee'].includes(a.type))));
  const pNonRetrouvees = unique(valides.filter((t) => t.statut === 'Non retrouvée' || t.resolution?.resultat === 'Non retrouvée'));
  const durees = resolues.map((t) => (t.resolution?.le ?? t.statutLe) - t.createdAt).filter((d) => d >= 0);
  const delaiMoyen = durees.length ? Math.round((durees.reduce((s, d) => s + d, 0) / durees.length / r.JOUR) * 10) / 10 : null;

  return {
    effectifs: {
      taches: valides.length, personnes: pEligibles.size, ouvertes: ouvertes.length, enRetard: enRetard.length,
      reintegrees: pReintegrees.size,
      reintegreesAvantContact: unique(valides.filter((t) => t.confirmation?.avantContact)).size,
      orientees: unique(valides.filter((t) => t.orientation)).size,
    },
    indicateurs: [
      indicateur('contact', 'Taux de contact', 'personnes', pContactees.size, pConfiees.size,
        'Personnes éligibles effectivement contactées ÷ personnes éligibles confiées au RECO × 100'),
      indicateur('visites', 'Taux de visites réalisées', 'visites', visitesEchues.filter((v) => v.realiseeLe).length, visitesEchues.length,
        'Visites réalisées ÷ visites planifiées arrivées à échéance × 100'),
      indicateur('reintegration', 'Taux de réintégration', 'personnes', pReintegrees.size, pEligibles.size,
        'Personnes dont la reprise du service est confirmée ÷ personnes éligibles à la relance de la cohorte × 100'),
      indicateur('resolues', 'Taux de tâches résolues', 'tâches', echues.filter((t) => FINAUX_VALIDES.includes(t.statut)).length, echues.length,
        'Tâches arrivées à échéance clôturées avec un résultat valide ÷ tâches arrivées à échéance × 100'),
      indicateur('retard', 'Taux de tâches en retard', 'tâches', enRetard.length, ouvertes.length,
        'Tâches ouvertes dont l’échéance est dépassée ÷ tâches ouvertes × 100'),
      indicateur('non_retrouves', 'Taux de non-retrouvés', 'personnes', pNonRetrouvees.size, pTentees.size,
        'Personnes classées « non retrouvée » ÷ personnes ayant fait l’objet d’une tentative de relance × 100'),
      { code: 'delai', libelle: 'Délai moyen de résolution', unite: 'jours', numerateur: durees.length, denominateur: null, valeur: delaiMoyen,
        formule: 'Somme des durées entre création et clôture des tâches résolues ÷ nombre de tâches résolues' },
    ],
  };
}

/** Petits effectifs masqués : une valeur inférieure au seuil n'est pas affichée. */
const masquer = (n) => (n > 0 && n < r.SEUIL_PETITS_EFFECTIFS ? null : n);

/** Âge en mois révolus d'un enfant, en années de la mère (date de naissance ou âge déclaré). */
async function trancheAge(taches) {
  const patientes = new Map((await Patiente.find({ _id: { $in: taches.filter((t) => t.personneType === 'Patiente').map((t) => t.patienteId) } })
    .select('dateNaissance ageDeclare ageDeclareLe createdAt')).map((p) => [p.id, p]));
  const enfants = new Map((await Enfant.find({ _id: { $in: taches.filter((t) => t.enfantId).map((t) => t.enfantId) } })
    .select('dateNaissance')).map((e) => [e.id, e]));
  const aujourdhui = jourKinshasa();
  return (t) => {
    if (t.personneType === 'Enfant') {
      const e = enfants.get(String(t.enfantId));
      if (!e) return 'Enfant — âge inconnu';
      const mois = Math.floor((Date.parse(aujourdhui) - Date.parse(e.dateNaissance)) / (30.44 * r.JOUR));
      return mois < 12 ? 'Enfant 0–11 mois' : mois < 24 ? 'Enfant 12–23 mois' : 'Enfant 24–59 mois';
    }
    if (t.personneType === 'Patiente') {
      const age = patientes.get(String(t.patienteId))?.age();
      if (age == null) return 'Femme — âge inconnu';
      return age < 20 ? 'Femme moins de 20 ans' : age < 35 ? 'Femme 20–34 ans' : 'Femme 35 ans et plus';
    }
    return 'Personne signalée (non identifiée)';
  };
}

/** Désagrégation : personnes et réintégrations par groupe, petits effectifs masqués. */
function desagreger(taches, cle) {
  const groupes = new Map();
  for (const t of taches.filter((x) => x.statut !== 'Doublon annulé')) {
    const k = cle(t) || 'Non renseigné';
    if (!groupes.has(k)) groupes.set(k, []);
    groupes.get(k).push(t);
  }
  return [...groupes.entries()].map(([groupe, liste]) => {
    const personnes = unique(liste).size;
    const reintegrees = unique(liste.filter((t) => t.statut === 'Réintégration confirmée')).size;
    const masque = masquer(personnes) == null || masquer(reintegrees) == null;
    return { groupe, personnes: masquer(personnes), reintegrees: masquer(reintegrees), taux: masque ? null : taux(reintegrees, personnes), masque };
  }).sort((a, b) => a.groupe.localeCompare(b.groupe, 'fr'));
}

exports.tableauDeBord = async (req, res) => {
  if (!estSuperviseur(req)) throw erreur(403, 'Tableau de bord réservé aux superviseurs et responsables.');
  const q = req.query;
  const maintenant = new Date();
  const au = jour(q.au, 'Fin de période') ?? jourKinshasa(maintenant);
  const du = jour(q.du, 'Début de période') ?? jourKinshasa(new Date(maintenant - 90 * r.JOUR));
  if (du > au) throw erreur(400, 'La période est invalide.');
  const filtre = {
    ...filtreTerritoire(req),
    createdAt: { $gte: new Date(`${du}T00:00:00+01:00`), $lt: new Date(new Date(`${au}T00:00:00+01:00`).getTime() + r.JOUR) },
  };
  if (q.parcours) filtre.parcoursCode = q.parcours === 'aucun' ? null : texte(q.parcours, 12);
  if (r.DOMAINES.includes(q.domaine)) filtre.domaine = q.domaine;
  if (q.aire) filtre.aireSante = texte(q.aire, 120);
  if (mongoose.isValidObjectId(q.reco)) filtre.recoId = q.reco;

  const taches = await TacheRelance.find(filtre)
    .select('numero statut statutLe ouverte priorite domaine parcoursCode personneType patienteId enfantId recoId aireSante echeance attribueeLe contactEtabliLe visites actions.type actions.horsLigne actions.conflit orientation confirmation resolution conflits reattributions motifs.cle createdAt');
  const valides = taches.filter((t) => t.statut !== 'Doublon annulé');
  const general = calculer(taches, maintenant);

  // Charge de travail (instantané des tâches de la cohorte encore ouvertes).
  const ouvertes = valides.filter((t) => t.ouverte);
  const parStatut = Object.fromEntries(r.STATUTS.map((s) => [s, taches.filter((t) => t.statut === s).length]));
  const recos = await Reco.find({ _id: { $in: [...new Set(taches.map((t) => t.recoId).filter(Boolean).map(String))] } }).select('matricule prenom nom statut');
  const parReco = recos.map((x) => {
    const siennes = ouvertes.filter((t) => String(t.recoId) === x.id);
    return { id: x.id, matricule: x.matricule, nom: `${x.prenom} ${x.nom}`, statut: x.statut, ouvertes: siennes.length, enRetard: siennes.filter((t) => t.echeance < maintenant).length };
  }).sort((a, b) => b.ouvertes - a.ouvertes);
  const aires = [...new Set(valides.map((t) => t.aireSante || 'Non renseignée'))];
  const parAire = aires.map((aire) => {
    const liste = ouvertes.filter((t) => (t.aireSante || 'Non renseignée') === aire);
    return { aire, ouvertes: liste.length, enRetard: liste.filter((t) => t.echeance < maintenant).length };
  });

  // Chaque parcours séparément, et les signalements non rattachés à part.
  const parcours = await ParcoursRelance.find().select('code libelle statut version');
  const parParcours = [...parcours.map((p) => ({ code: p.code, libelle: p.libelle, statut: p.statut, version: p.version })), { code: null, libelle: 'Sans parcours (signalements RECO)' }]
    .map((p) => ({ ...p, ...calculer(taches.filter((t) => (t.parcoursCode ?? null) === p.code), maintenant) }));

  // Continuum mère-enfant : CPN, accouchement, postnatal, vaccination présentés séparément.
  const continuum = r.DOMAINES.map((domaine) => {
    const liste = valides.filter((t) => t.domaine === domaine);
    return {
      domaine, taches: liste.length, personnes: unique(liste).size, ouvertes: liste.filter((t) => t.ouverte).length,
      reintegrees: unique(liste.filter((t) => t.statut === 'Réintégration confirmée')).size,
      taux: taux(unique(liste.filter((t) => t.statut === 'Réintégration confirmée')).size, unique(liste).size),
    };
  });

  // Qualité des données.
  const qualite = {
    doublonsAnnules: taches.filter((t) => t.statut === 'Doublon annulé').length,
    sansMotifCloture: valides.filter((t) => !t.ouverte && !t.resolution?.motif).length,
    sansRecoDepuisPlusDe2Jours: ouvertes.filter((t) => !t.recoId && maintenant - t.createdAt > 2 * r.JOUR).length,
    sansAireSante: valides.filter((t) => !t.aireSante).length,
    incoherents: [
      { libelle: 'Réintégration confirmée sans référence de prestation', nombre: valides.filter((t) => t.statut === 'Réintégration confirmée' && !t.confirmation?.reference).length },
      { libelle: 'Orientée sans contact établi', nombre: valides.filter((t) => t.statut === 'Orientée' && !t.contactEtabliLe).length },
      { libelle: 'Contact établi sans date de contact', nombre: valides.filter((t) => t.statut === 'Contact établi' && !t.contactEtabliLe).length },
      { libelle: 'Tâche ouverte sans motif', nombre: ouvertes.filter((t) => !t.motifs.length).length },
    ],
    conflitsEnAttente: taches.reduce((n, t) => n + t.conflits.filter((c) => !c.resolu).length, 0),
  };

  // Traçabilité.
  const tracabilite = {
    reattributions: taches.reduce((n, t) => n + t.reattributions, 0),
    cloturesExceptionnelles: taches.filter((t) => t.resolution?.exceptionnelle).length,
    actionsHorsLigne: taches.reduce((n, t) => n + t.actions.filter((a) => a.horsLigne).length, 0),
    actionsEnConflit: taches.reduce((n, t) => n + t.actions.filter((a) => a.conflit).length, 0),
    synchronisations: (await Reco.find(filtreTerritoire(req)).select('matricule prenom nom derniereSynchronisation statut'))
      .map((x) => ({ matricule: x.matricule, nom: `${x.prenom} ${x.nom}`, statut: x.statut, derniereSynchronisation: x.derniereSynchronisation })),
  };

  // Équité et désagrégation (petits effectifs masqués).
  const age = await trancheAge(valides);
  const equite = {
    seuil: r.SEUIL_PETITS_EFFECTIFS,
    parAge: desagreger(valides, age),
    parAire: desagreger(valides, (t) => t.aireSante),
  };

  await journaliser(req, { action: 'relance.tableau_de_bord', details: { du, au } });
  res.json({
    periode: { du, au }, genereLe: maintenant,
    charge: { parStatut, ouvertes: ouvertes.length, enRetard: ouvertes.filter((t) => t.echeance < maintenant).length, nonAttribuees: ouvertes.filter((t) => !t.recoId).length, parReco, parAire },
    performance: general, parParcours, continuum, qualite, equite, tracabilite,
  });
};

module.exports.calculer = calculer;
