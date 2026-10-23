// Calendrier du Programme élargi de vaccination (PEV) de la RDC et suivi préscolaire de l'enfant
// (supplémentation en vitamine A, déparasitage). Source unique : le carnet de l'enfant, les
// rendez-vous automatiques et l'espace patiente sont calculés d'ici ; l'équipe PEV ajuste cette
// liste si le calendrier national évolue (nouvel antigène, nouvel âge).
//
// age        : âge recommandé (jours, semaines ou mois révolus depuis la naissance) ;
// apres      : dose précédente de la même série, à respecter avec intervalleJours au minimum ;
// limiteJours: âge au-delà duquel la dose n'est plus administrée (sinon rattrapage possible).

const JOUR = 86400000;
/** Une dose reste « à faire » pendant ce délai après sa date, puis passe « en retard ». */
const TOLERANCE_JOURS = 14;
const INTERVALLE_SERIE_JOURS = 28;
const FUSEAU_MS = 60 * 60000; // Africa/Kinshasa : UTC+1, sans heure d'été

const TYPES = ['Vaccin', 'Supplémentation', 'Déparasitage'];

const vaccin = (code, libelle, antigene, maladies, voie, age, seance, extra = {}) => ({
  code, libelle, antigene, maladies, voie, age, seance, type: 'Vaccin', ...extra,
});
const serie = (precedent) => ({ apres: precedent, intervalleJours: INTERVALLE_SERIE_JOURS });

const PENTA = 'Diphtérie, tétanos, coqueluche, hépatite B, Haemophilus influenzae b';
const CALENDRIER = [
  // Naissance
  vaccin('bcg', 'BCG', 'BCG', 'Tuberculose', 'Intradermique (bras gauche)', { jours: 0 }, 'Naissance', { limiteJours: 365 }),
  vaccin('vpo0', 'VPO 0', 'VPO', 'Poliomyélite', 'Orale', { jours: 0 }, 'Naissance', { limiteJours: 14 }),
  // 6 semaines
  vaccin('penta1', 'DTC-HepB-Hib 1', 'DTC-HepB-Hib', PENTA, 'Intramusculaire (cuisse gauche)', { semaines: 6 }, '6 semaines'),
  vaccin('vpo1', 'VPO 1', 'VPO', 'Poliomyélite', 'Orale', { semaines: 6 }, '6 semaines'),
  vaccin('pcv1', 'Pneumo 1 (PCV13)', 'PCV13', 'Infections à pneumocoque', 'Intramusculaire (cuisse droite)', { semaines: 6 }, '6 semaines'),
  vaccin('rota1', 'Rota 1', 'Rotavirus', 'Diarrhées à rotavirus', 'Orale', { semaines: 6 }, '6 semaines'),
  // 10 semaines
  vaccin('penta2', 'DTC-HepB-Hib 2', 'DTC-HepB-Hib', PENTA, 'Intramusculaire (cuisse gauche)', { semaines: 10 }, '10 semaines', serie('penta1')),
  vaccin('vpo2', 'VPO 2', 'VPO', 'Poliomyélite', 'Orale', { semaines: 10 }, '10 semaines', serie('vpo1')),
  vaccin('pcv2', 'Pneumo 2 (PCV13)', 'PCV13', 'Infections à pneumocoque', 'Intramusculaire (cuisse droite)', { semaines: 10 }, '10 semaines', serie('pcv1')),
  vaccin('rota2', 'Rota 2', 'Rotavirus', 'Diarrhées à rotavirus', 'Orale', { semaines: 10 }, '10 semaines', serie('rota1')),
  // 14 semaines
  vaccin('penta3', 'DTC-HepB-Hib 3', 'DTC-HepB-Hib', PENTA, 'Intramusculaire (cuisse gauche)', { semaines: 14 }, '14 semaines', serie('penta2')),
  vaccin('vpo3', 'VPO 3', 'VPO', 'Poliomyélite', 'Orale', { semaines: 14 }, '14 semaines', serie('vpo2')),
  vaccin('pcv3', 'Pneumo 3 (PCV13)', 'PCV13', 'Infections à pneumocoque', 'Intramusculaire (cuisse droite)', { semaines: 14 }, '14 semaines', serie('pcv2')),
  vaccin('rota3', 'Rota 3', 'Rotavirus', 'Diarrhées à rotavirus', 'Orale', { semaines: 14 }, '14 semaines', serie('rota2')),
  vaccin('vpi1', 'VPI 1', 'VPI', 'Poliomyélite', 'Intramusculaire (cuisse droite)', { semaines: 14 }, '14 semaines'),
  // 9 mois
  vaccin('var1', 'VAR 1', 'VAR', 'Rougeole', 'Sous-cutanée (bras gauche)', { mois: 9 }, '9 mois'),
  vaccin('vaa', 'VAA', 'VAA', 'Fièvre jaune', 'Sous-cutanée (bras droit)', { mois: 9 }, '9 mois'),
  vaccin('vpi2', 'VPI 2', 'VPI', 'Poliomyélite', 'Intramusculaire', { mois: 9 }, '9 mois', serie('vpi1')),
  // 15 mois
  vaccin('var2', 'VAR 2', 'VAR', 'Rougeole', 'Sous-cutanée (bras gauche)', { mois: 15 }, '15 mois', serie('var1')),

  // Suivi préscolaire : vitamine A tous les 6 mois de 6 à 59 mois, mébendazole tous les 6 mois dès 12 mois.
  ...[6, 12, 18, 24, 30, 36, 42, 48, 54].map((m, i) => ({
    code: `vitA${i + 1}`, libelle: `Vitamine A (${m} mois)`, antigene: 'Vitamine A', maladies: 'Carence en vitamine A',
    voie: 'Orale', age: { mois: m }, seance: `${m} mois`, type: 'Supplémentation', limiteJours: 1825,
  })),
  ...[12, 18, 24, 30, 36, 42, 48, 54].map((m, i) => ({
    code: `meb${i + 1}`, libelle: `Mébendazole (${m} mois)`, antigene: 'Mébendazole', maladies: 'Parasitoses intestinales',
    voie: 'Orale', age: { mois: m }, seance: `${m} mois`, type: 'Déparasitage', limiteJours: 1825,
  })),
];
const CODES = CALENDRIER.map((d) => d.code);
const PAR_CODE = new Map(CALENDRIER.map((d) => [d.code, d]));

const jourMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Jour civil à Kinshasa (AAAA-MM-JJ) d'un instant. */
const jourKinshasa = (date = new Date()) => iso(new Date(date).getTime() + FUSEAU_MS);

/** Date (AAAA-MM-JJ) à laquelle l'enfant atteint l'âge donné. */
function dateAge(dateNaissance, { jours = 0, semaines = 0, mois = 0 }) {
  const [a, m, j] = dateNaissance.split('-').map(Number);
  // Mois révolus : même jour du mois, ramené au dernier jour si le mois est plus court.
  const finMois = new Date(Date.UTC(a, m - 1 + mois + 1, 0)).getUTCDate();
  const base = Date.UTC(a, m - 1 + mois, Math.min(j, finMois));
  return iso(base + (jours + semaines * 7) * JOUR);
}

/**
 * Carnet de l'enfant : chaque dose du calendrier avec sa date prévue et son statut
 * (Faite, À venir, À faire, En retard, Hors délai), et la prochaine séance à programmer.
 */
function calendrier(dateNaissance, administrations = [], aujourdhui = jourKinshasa()) {
  const faites = new Map();
  for (const a of administrations) if (!faites.has(a.code)) faites.set(a.code, a);
  const prevues = new Map();
  const doses = CALENDRIER.map((d) => {
    let prevue = dateAge(dateNaissance, d.age);
    // Série : au moins `intervalleJours` après la dose précédente (faite, sinon prévue).
    if (d.apres) {
      const avant = faites.get(d.apres)?.date ?? prevues.get(d.apres);
      if (avant) prevue = iso(Math.max(jourMs(prevue), jourMs(avant) + d.intervalleJours * JOUR));
    }
    prevues.set(d.code, prevue);
    const limite = d.limiteJours != null ? iso(jourMs(dateNaissance) + d.limiteJours * JOUR) : null;
    const faite = faites.get(d.code);
    let statut;
    if (faite) statut = 'Faite';
    else if (limite && aujourdhui > limite) statut = 'Hors délai';
    else if (aujourdhui < prevue) statut = 'À venir';
    else if (jourMs(aujourdhui) - jourMs(prevue) <= TOLERANCE_JOURS * JOUR) statut = 'À faire';
    else statut = 'En retard';
    return {
      code: d.code, libelle: d.libelle, type: d.type, antigene: d.antigene, maladies: d.maladies, voie: d.voie,
      seance: d.seance, datePrevue: prevue, dateLimite: limite, statut,
      administration: faite ? { date: faite.date, lot: faite.lot ?? '', site: faite.site ?? '', lieu: faite.lieu ?? '' } : null,
    };
  });

  const attendues = doses.filter((d) => ['À faire', 'En retard'].includes(d.statut));
  const aVenir = doses.filter((d) => d.statut === 'À venir');
  let prochaineSeance = null;
  if (attendues.length) {
    prochaineSeance = { date: aujourdhui, doses: attendues };
  } else if (aVenir.length) {
    const date = aVenir.reduce((min, d) => (d.datePrevue < min ? d.datePrevue : min), aVenir[0].datePrevue);
    prochaineSeance = { date, doses: aVenir.filter((d) => d.datePrevue === date) };
  }
  const vaccins = doses.filter((d) => d.type === 'Vaccin');
  return {
    doses,
    prochaineSeance: prochaineSeance && {
      date: prochaineSeance.date,
      doses: prochaineSeance.doses.map((d) => ({ code: d.code, libelle: d.libelle, type: d.type, statut: d.statut })),
    },
    resume: {
      vaccinsFaits: vaccins.filter((d) => d.statut === 'Faite').length,
      vaccinsTotal: vaccins.length,
      enRetard: doses.filter((d) => d.statut === 'En retard').length,
      // Vaccins de la 1re année (jusqu'à VAR 1 / VAA) tous faits : enfant complètement vacciné.
      completementVaccine: vaccins.filter((d) => d.seance !== '15 mois').every((d) => d.statut === 'Faite'),
    },
  };
}

module.exports = { CALENDRIER, CODES, PAR_CODE, TYPES, TOLERANCE_JOURS, calendrier, dateAge, jourKinshasa };
