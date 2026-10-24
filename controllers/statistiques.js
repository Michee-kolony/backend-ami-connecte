// Indicateurs du tableau de bord (suivi prénatal), calculés sur les données réelles.
// Agrégats et listes minimisées : ouverts à tout le personnel soignant ; les indicateurs de
// risque ne sont renvoyés qu'aux médecins.
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const RendezVous = require('../models/RendezVous');
const Enfant = require('../models/Enfant');
const { ROLES_MEDECIN } = require('../models/Soignant');
const { PROVINCES_RDC } = require('../config/referentiels');
const { urlSignee } = require('../config/r2');
const vaccination = require('../config/vaccination');

const JOUR = 86400000;
const FUSEAU_MS = 60 * 60000; // Africa/Kinshasa : UTC+1, sans heure d'été

/** Minuit (heure de Kinshasa) du jour contenant `date`, en instant UTC. */
function minuitKinshasa(date = new Date()) {
  const local = new Date(date.getTime() + FUSEAU_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - FUSEAU_MS);
}

/** Numéro de semaine ISO 8601. */
function semaineIso(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const jour = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - jour);
  const debutAnnee = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - debutAnnee) / JOUR + 1) / 7);
}

/** Lundi (00:00, Kinshasa) de la semaine de `date`. */
function lundi(date) {
  const m = minuitKinshasa(date);
  const local = new Date(m.getTime() + FUSEAU_MS);
  const decalage = (local.getUTCDay() + 6) % 7;
  return new Date(m.getTime() - decalage * JOUR);
}

/** Premier jour du mois (00:00, Kinshasa), décalé de `n` mois. */
function debutMois(n = 0) {
  const local = new Date(Date.now() + FUSEAU_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + n, 1) - FUSEAU_MS);
}

exports.patientes = async (req, res) => {
  const estMedecin = ROLES_MEDECIN.includes(req.soignant.role);
  const maintenant = new Date();
  const aujourdhui = minuitKinshasa(maintenant);
  const SEMAINES = 8;
  const premiereSemaine = new Date(lundi(maintenant).getTime() - (SEMAINES - 1) * 7 * JOUR);

  const [patientes, enCours, rdvs, recentes] = await Promise.all([
    Patiente.find().select('adresse.province telephone dateNaissance createdAt statut').lean(),
    Grossesse.find({ statut: 'En cours' }).select('patienteId datation facteursRisque'),
    RendezVous.find({ date: { $gte: new Date(aujourdhui.getTime() - 30 * JOUR), $lt: new Date(aujourdhui.getTime() + 8 * JOUR) } })
      .select('patienteId date motif statut').sort({ date: 1 }).lean(),
    Patiente.find().sort({ createdAt: -1 }).limit(5),
  ]);

  // --- Totaux -----------------------------------------------------------------------
  const moisCourant = debutMois(0);
  const moisPrecedent = debutMois(-1);
  const nouvellesCeMois = patientes.filter((p) => p.createdAt >= moisCourant).length;
  const nouvellesMoisPrecedent = patientes.filter((p) => p.createdAt >= moisPrecedent && p.createdAt < moisCourant).length;

  // Âge gestationnel des grossesses en cours → trimestres (non datées comptées à part).
  const trimestres = { t1: 0, t2: 0, t3: 0, nonDatees: 0 };
  for (const g of enCours) {
    const ag = g.agJoursLe(maintenant);
    if (ag == null) trimestres.nonDatees++;
    else if (ag < 14 * 7) trimestres.t1++;
    else if (ag < 28 * 7) trimestres.t2++;
    else trimestres.t3++;
  }
  const aRisque = enCours.filter((g) => g.facteursRisque.length > 0).length;

  const ACTIFS = RendezVous.STATUTS_ACTIFS;
  const demain = new Date(aujourdhui.getTime() + JOUR);
  const rdvAujourdhui = rdvs.filter((r) => ACTIFS.includes(r.statut) && r.date >= aujourdhui && r.date < demain).length;
  const rdv7Jours = rdvs.filter((r) => ACTIFS.includes(r.statut) && r.date >= maintenant && r.date < new Date(aujourdhui.getTime() + 8 * JOUR)).length;
  // Absences : notées « Absent », ou rendez-vous passés restés sans suite.
  const absences30Jours = rdvs.filter((r) => r.date < aujourdhui && (r.statut === 'Absent' || ACTIFS.includes(r.statut))).length;

  // --- Inscriptions par semaine ------------------------------------------------------
  const semaines = Array.from({ length: SEMAINES }, (_, i) => {
    const debut = new Date(premiereSemaine.getTime() + i * 7 * JOUR);
    const fin = new Date(debut.getTime() + 7 * JOUR);
    return {
      debut, label: `S${semaineIso(new Date(debut.getTime() + FUSEAU_MS))}`,
      inscriptions: patientes.filter((p) => p.createdAt >= debut && p.createdAt < fin).length,
    };
  });

  // --- Provinces (carte de la RDC) ----------------------------------------------------
  const provinceDe = new Map(patientes.map((p) => [String(p._id), p.adresse?.province || '']));
  const provinces = PROVINCES_RDC.map((province) => ({ province, patientes: 0, grossessesEnCours: 0 }));
  const parNom = new Map(provinces.map((p) => [p.province, p]));
  let sansProvince = 0;
  for (const p of patientes) {
    const ligne = parNom.get(p.adresse?.province);
    if (ligne) ligne.patientes++;
    else sansProvince++;
  }
  for (const g of enCours) {
    const ligne = parNom.get(provinceDe.get(String(g.patienteId)));
    if (ligne) ligne.grossessesEnCours++;
  }

  // --- Qualité des données ------------------------------------------------------------
  const sansTelephone = patientes.filter((p) => !(p.telephone || '').trim()).length;
  const avecDateNaissance = patientes.filter((p) => p.dateNaissance).length;
  const datees = enCours.length - trimestres.nonDatees;
  const criteres = patientes.length + patientes.length + enCours.length;
  const completude = criteres
    ? Math.round(((patientes.length - sansTelephone) + avecDateNaissance + datees) / criteres * 100)
    : null;

  // --- Listes minimisées ----------------------------------------------------------------
  const grossesseDe = new Map(enCours.map((g) => [String(g.patienteId), g]));
  const photos = await Promise.all(recentes.map((p) => urlSignee(p.photoCle)));
  // Sans horizon : les prochains rendez-vous peuvent tomber au-delà de la fenêtre des compteurs.
  const prochains = await RendezVous.find({ statut: { $in: ACTIFS }, date: { $gte: aujourdhui } })
    .select('patienteId date motif statut').sort({ date: 1 }).limit(5).lean();
  const identites = await Patiente.find({ _id: { $in: prochains.map((r) => r.patienteId) } }).select('numero nom prenom postnom').lean();
  const identiteDe = new Map(identites.map((p) => [String(p._id), p]));

  res.json({
    genereLe: maintenant,
    totaux: {
      patientes: patientes.length,
      nouvellesCeMois,
      nouvellesMoisPrecedent,
      grossessesEnCours: enCours.length,
      ...(estMedecin ? { grossessesARisque: aRisque } : {}),
      rdvAujourdhui,
      rdv7Jours,
      absences30Jours,
    },
    trimestres,
    semaines,
    provinces,
    sansProvince,
    qualite: { grossessesNonDatees: trimestres.nonDatees, sansTelephone, completude },
    recentes: recentes.map((p, i) => {
      const g = grossesseDe.get(p.id);
      return {
        id: p.id, numero: p.numero, nom: p.nom, prenom: p.prenom, postnom: p.postnom, photoUrl: photos[i],
        statut: p.statut, creeLe: p.createdAt, agJours: g ? g.agJoursLe(maintenant) : null,
        ...(estMedecin ? { aRisque: !!g && g.facteursRisque.length > 0 } : {}),
      };
    }),
    prochainsRdv: prochains.map((r) => {
      const p = identiteDe.get(String(r.patienteId));
      return {
        id: String(r._id), date: r.date, motif: r.motif, statut: r.statut,
        patiente: p ? { numero: p.numero, nom: p.nom, prenom: p.prenom, postnom: p.postnom } : null,
      };
    }),
  });
};

/** Antigènes suivis pour la couverture vaccinale du tableau de bord (codes du calendrier PEV). */
const COUVERTURE = [
  { code: 'bcg', age: 'Naissance' },
  { code: 'penta1', age: '6 sem.' },
  { code: 'penta3', age: '14 sem.' },
  { code: 'vpi1', age: '14 sem.' },
  { code: 'palu3', age: '8 mois' },
  { code: 'var1', age: '9 mois' },
  { code: 'vaa', age: '9 mois' },
];

// Bébés pris en charge et vaccination (PEV), calculés sur les dossiers des enfants.
exports.enfants = async (req, res) => {
  const jour = vaccination.jourKinshasa();
  const mois = jour.slice(0, 7);
  const moisPrecedent = vaccination.jourKinshasa(debutMois(-1)).slice(0, 7);
  const enfants = await Enfant.find().select('numero nom postnom prenom sexe neLe dateNaissance etatNaissance statut vaccinations mereId');

  const suivis = enfants.filter((e) => e.estSuivi());
  const carnets = new Map(suivis.map((e) => [e.id, e.carnet(jour)]));
  const resumes = suivis.map((e) => carnets.get(e.id).resume);
  const nesCeMois = enfants.filter((e) => e.dateNaissance.startsWith(mois)).length;
  const nesMoisPrecedent = enfants.filter((e) => e.dateNaissance.startsWith(moisPrecedent)).length;
  const doses = suivis.flatMap((e) => e.vaccinationsValides());

  // Couverture : enfants en âge d'avoir reçu la dose (statut échu ou faite).
  const couverture = COUVERTURE.map(({ code, age }) => {
    const d = vaccination.PAR_CODE.get(code);
    let eligibles = 0;
    let recus = 0;
    for (const e of suivis) {
      const dose = carnets.get(e.id).doses.find((x) => x.code === code);
      if (!dose || ['À venir', 'À faire'].includes(dose.statut)) continue;
      eligibles++;
      if (dose.statut === 'Faite') recus++;
    }
    return { code, libelle: d.libelle, age, eligibles, recus, pct: eligibles ? Math.round((recus / eligibles) * 100) : 0 };
  });

  // Enfants à rattraper : les plus en retard d'abord, avec le téléphone de la mère pour la relance.
  const enRetard = suivis
    .map((e) => ({ e, retard: carnets.get(e.id).doses.filter((d) => d.statut === 'En retard') }))
    .filter((x) => x.retard.length)
    .sort((a, b) => a.retard[0].datePrevue.localeCompare(b.retard[0].datePrevue));
  const aRattraper = enRetard.slice(0, 6);
  const meres = await Patiente.find({ _id: { $in: aRattraper.map((x) => x.e.mereId) } }).select('telephone').lean();
  const telephoneDe = new Map(meres.map((m) => [String(m._id), m.telephone || '']));

  res.json({
    genereLe: new Date(),
    totaux: {
      enfants: enfants.length,
      suivis: suivis.length,
      filles: enfants.filter((e) => e.sexe === 'Féminin').length,
      garcons: enfants.filter((e) => e.sexe === 'Masculin').length,
      nesCeMois,
      nesMoisPrecedent,
      complets: resumes.filter((r) => r.completementVaccine).length,
      enRetard: enRetard.length,
      dosesCeMois: doses.filter((v) => v.date.startsWith(mois)).length,
      seancesAujourdhui: suivis.filter((e) => carnets.get(e.id).prochaineSeance?.date === jour).length,
    },
    couverture,
    aRattraper: aRattraper.map(({ e, retard }) => ({
      id: e.id, numero: e.numero, nom: e.nom, prenom: e.prenom, sexe: e.sexe, age: e.age(jour)?.libelle ?? '',
      doses: retard.map((d) => d.libelle), depuis: retard[0].datePrevue,
      telephone: telephoneDe.get(String(e.mereId)) ?? '',
    })),
  });
};
