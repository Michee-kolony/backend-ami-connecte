// Partogramme de la phase active et règles d'alerte AMI Connect :
// - BCF hors 120–160 bpm : alerte sonore ;
// - dilatation qui passe en zone jaune : alerte ; qui stagne plus de 2 h en zone jaune : alerte sonore ;
// - passage en zone rouge : alerte sonore et notification automatique aux médecins.

const BCF = { min: 120, max: 160, echelle: [100, 180] };
/** Dilatation (cm) à partir de laquelle commence la phase active. */
const PHASE_ACTIVE_CM = 4;
const DILATATION_COMPLETE_CM = 10;
/** Ligne d'alerte : 1 cm/h depuis 4 cm ; ligne d'action : 4 h à sa droite. */
const VITESSE_CM_H = 1;
const DECALAGE_ACTION_H = 4;
const STAGNATION_H = 2;
const HEURE = 3600000;

/**
 * Zone d'un point du partogramme : verte sur ou à gauche de la ligne d'alerte, jaune entre
 * la ligne d'alerte et la ligne d'action, rouge à droite de la ligne d'action.
 */
function zoneDilatation(heures, cm) {
  const alerte = Math.min(DILATATION_COMPLETE_CM, PHASE_ACTIVE_CM + VITESSE_CM_H * heures);
  if (cm >= alerte) return 'Verte';
  const action = Math.min(DILATATION_COMPLETE_CM, PHASE_ACTIVE_CM + VITESSE_CM_H * (heures - DECALAGE_ACTION_H));
  return cm >= action ? 'Jaune' : 'Rouge';
}

const bcfAnormal = (bcf) => bcf != null && (bcf < BCF.min || bcf > BCF.max);

/** Lignes tracées sur le graphe de dilatation (heures depuis le début de la phase active). */
function lignes() {
  const duree = (DILATATION_COMPLETE_CM - PHASE_ACTIVE_CM) / VITESSE_CM_H;
  return {
    alerte: [{ heures: 0, cm: PHASE_ACTIVE_CM }, { heures: duree, cm: DILATATION_COMPLETE_CM }],
    action: [{ heures: DECALAGE_ACTION_H, cm: PHASE_ACTIVE_CM }, { heures: DECALAGE_ACTION_H + duree, cm: DILATATION_COMPLETE_CM }],
  };
}

/** Points de dilatation de la phase active, triés, avec leur zone. */
function pointsDilatation(surveillances, debutPhaseActive) {
  if (!debutPhaseActive) return [];
  const debut = new Date(debutPhaseActive).getTime();
  return surveillances
    .filter((s) => s.dilatationCm != null && new Date(s.le).getTime() >= debut)
    .sort((a, b) => a.le - b.le)
    .map((s) => {
      const heures = Math.round(((s.le - debut) / HEURE) * 100) / 100;
      return { id: String(s._id), le: s.le, heures, cm: s.dilatationCm, zone: zoneDilatation(heures, s.dilatationCm) };
    });
}

/** Nombre minimal de colonnes horaires du tableau sous les graphes, comme sur la feuille. */
const COLONNES_TABLEAU = 14;

/**
 * Tableau horaire sous le graphe de dilatation : une colonne par heure écoulée depuis le début
 * de la phase active (colonne 1 = de 0 à 1 h). Dans une colonne, chaque ligne garde la dernière
 * valeur saisie dans l'heure ; les médicaments et injections IV de l'heure sont tous repris.
 */
function tableauHoraire(surveillances, debutPhaseActive) {
  if (!debutPhaseActive) return { colonnes: [] };
  const debut = new Date(debutPhaseActive).getTime();
  const actives = surveillances
    .filter((s) => new Date(s.le).getTime() >= debut)
    .sort((a, b) => a.le - b.le);
  const numero = (s) => Math.floor((new Date(s.le).getTime() - debut) / HEURE) + 1;
  const nombre = Math.max(COLONNES_TABLEAU, ...actives.map(numero));
  const colonnes = Array.from({ length: nombre }, (_, i) => ({
    heure: i + 1,
    debut: new Date(debut + i * HEURE),
    contractions10min: null, dureeContractionsSec: null, membranes: null, liquideAmniotique: null,
    pertesSang: null, temperature: null, pouls: null, taSystolique: null, taDiastolique: null, diurese: null,
    ocytocineUParMl: null, ocytocineGouttesMin: null, medicamentsIV: [],
  }));
  const valeurs = (s) => ({
    contractions10min: s.contractions10min, dureeContractionsSec: s.dureeContractionsSec, membranes: s.membranes,
    liquideAmniotique: s.liquideAmniotique, pertesSang: s.saignement, temperature: s.temperature, pouls: s.pouls,
    taSystolique: s.taSystolique, taDiastolique: s.taDiastolique, diurese: s.diurese,
    ocytocineUParMl: s.ocytocine?.uParMl, ocytocineGouttesMin: s.ocytocine?.gouttesMin,
  });
  for (const s of actives) {
    const c = colonnes[numero(s) - 1];
    for (const [cle, v] of Object.entries(valeurs(s))) if (v != null && v !== '') c[cle] = v;
    if (s.medicamentsIV && !c.medicamentsIV.includes(s.medicamentsIV)) c.medicamentsIV.push(s.medicamentsIV);
  }
  return { colonnes };
}

/** Données des graphes du partogramme (BCF, dilatation et effacement du col). */
function partogramme(surveillances, debutPhaseActive) {
  const debut = debutPhaseActive ? new Date(debutPhaseActive).getTime() : null;
  const points = pointsDilatation(surveillances, debutPhaseActive);
  const heures = (s) => (debut != null ? Math.round(((s.le - debut) / HEURE) * 100) / 100 : null);
  return {
    debutPhaseActive: debutPhaseActive ?? null,
    bcf: {
      ...BCF,
      points: surveillances
        .filter((s) => s.bcf != null)
        .sort((a, b) => a.le - b.le)
        .map((s) => ({
          id: String(s._id), le: s.le, phase: s.phase, bcf: s.bcf, anormal: bcfAnormal(s.bcf), heures: heures(s),
        })),
    },
    effacement: {
      echelle: [0, 100],
      points: surveillances
        .filter((s) => s.effacementPct != null)
        .sort((a, b) => a.le - b.le)
        .map((s) => ({ id: String(s._id), le: s.le, phase: s.phase, pct: s.effacementPct, heures: heures(s) })),
    },
    dilatation: {
      echelle: [PHASE_ACTIVE_CM, DILATATION_COMPLETE_CM],
      lignes: lignes(),
      points,
      zoneActuelle: points.at(-1)?.zone ?? null,
    },
    // Lignes « Engagement » (M, A, F, E, D) et « Incident » sous le graphe des BCF.
    reperes: surveillances
      .filter((s) => s.engagement || s.incident)
      .sort((a, b) => a.le - b.le)
      .map((s) => ({ id: String(s._id), le: s.le, heures: heures(s), engagement: s.engagement || null, incident: s.incident || null })),
    // Tableau sous le graphe de dilatation (contractions, membranes, LA, constantes, ocytocine, médicaments IV).
    tableau: tableauHoraire(surveillances, debutPhaseActive),
  };
}

/**
 * Mesures d'un dossier d'accouchement tracées sur le partogramme : surveillances du travail et,
 * en premier point, le BCF, la dilatation et l'effacement de l'examen clinique d'entrée. Une
 * dilatation ≥ 4 cm à l'entrée fait commencer la phase active à l'heure de l'examen.
 */
function mesures(a) {
  const liste = [...a.surveillances];
  let debutPhaseActive = a.phaseActiveLe ?? null;
  const ex = a.examenClinique;
  const o = ex?.obstetrical;
  const tv = o?.toucherVaginal;
  // Relevés horodatés ; anciens dossiers : un seul BCF / dilatation à l'heure de l'examen.
  const releves = o?.releves?.length ? o.releves
    : ex?.examineLe && (o?.bcf != null || tv?.dilatationCm != null || tv?.effacementPct != null)
      ? [{ le: ex.examineLe, bcf: o.bcf, dilatationCm: tv?.dilatationCm }] : [];
  releves.forEach((r, i) => {
    const active = r.dilatationCm != null && r.dilatationCm >= PHASE_ACTIVE_CM;
    if (active && (!debutPhaseActive || r.le < debutPhaseActive)) debutPhaseActive = r.le;
    liste.push({
      _id: i ? `examen-entree-${i + 1}` : 'examen-entree', le: r.le, phase: active ? 'Active' : 'Latence',
      bcf: r.bcf ?? null, dilatationCm: r.dilatationCm ?? null, effacementPct: i ? null : tv?.effacementPct ?? null,
    });
  });
  return { surveillances: liste, debutPhaseActive };
}

/** Heure de rupture des membranes : examen d'entrée, sinon première surveillance « Rompues ». */
function ruptureLe(a) {
  return a.examenClinique?.obstetrical?.pocheEaux?.rompueLe
    ?? [...a.surveillances].sort((x, y) => x.le - y.le).find((s) => s.membranes === 'Rompues')?.le
    ?? null;
}

/** Phase du travail à l'arrivée, d'après la première dilatation connue (examen d'entrée en priorité). */
function phaseArrivee(a) {
  const o = a.examenClinique?.obstetrical;
  const releve = [...(o?.releves ?? [])].sort((x, y) => x.le - y.le).find((r) => r.dilatationCm != null);
  const cm = releve?.dilatationCm ?? o?.toucherVaginal?.dilatationCm
    ?? [...a.surveillances].sort((x, y) => x.le - y.le).find((s) => s.dilatationCm != null)?.dilatationCm;
  if (cm == null) return null;
  return cm >= DILATATION_COMPLETE_CM ? 'Dilatation complète' : cm >= PHASE_ACTIVE_CM ? 'Active' : 'Latence';
}

/** Colonnes minimales du tableau de la phase de latence (0 à 12 h depuis l'arrivée), comme sur la feuille. */
const COLONNES_LATENCE = 13;
const uneDecimale = (h) => Math.round(h * 10) / 10;

/**
 * Tableau « Surveillance de la phase de latence (< 4 cm) » : une colonne par heure écoulée depuis
 * l'arrivée (colonne 0 = première heure), avec l'examen d'entrée et les surveillances antérieures
 * au début de la phase active. Dans une colonne, chaque ligne garde la dernière valeur de l'heure ;
 * les temps depuis la rupture et le début du travail sont calculés à l'heure de cette dernière mesure.
 */
function tableauLatence(a) {
  const arrivee = new Date(a.admission.admiseLe).getTime();
  const m = mesures(a);
  const fin = m.debutPhaseActive ? new Date(m.debutPhaseActive).getTime() : Infinity;
  const ex = a.examenClinique;
  const entrees = [...m.surveillances];
  if (ex?.examineLe) {
    const ph = ex.physique ?? {};
    entrees.push({
      le: ex.examineLe, temperature: ph.temperature, pouls: ph.pouls, taSystolique: ph.taSystolique,
      taDiastolique: ph.taDiastolique, contractions10min: ex.obstetrical?.contractions10min,
    });
  }
  const latentes = entrees
    .filter((s) => new Date(s.le).getTime() < fin)
    .sort((x, y) => x.le - y.le);
  const numero = (s) => Math.max(0, Math.floor((new Date(s.le).getTime() - arrivee) / HEURE));
  const nombre = Math.max(COLONNES_LATENCE, ...latentes.map((s) => numero(s) + 1));
  const rupture = ruptureLe(a);
  const debutTravail = a.admission.debutTravail;
  const colonnes = Array.from({ length: nombre }, (_, i) => ({
    heure: i, debut: new Date(arrivee + i * HEURE), mesureLe: null,
    ruptureH: null, debutTravailH: null, saignement: null, contractions10min: null, dureeContractionsSec: null,
    bcf: null, temperature: null, pouls: null, taSystolique: null, taDiastolique: null, diurese: null, dilatationCm: null,
  }));
  const champs = ['saignement', 'contractions10min', 'dureeContractionsSec', 'bcf', 'temperature', 'pouls', 'taSystolique', 'taDiastolique', 'diurese', 'dilatationCm'];
  for (const s of latentes) {
    const c = colonnes[numero(s)];
    let mesure = false;
    for (const cle of champs) if (s[cle] != null && s[cle] !== '') { c[cle] = s[cle]; mesure = true; }
    if (!mesure) continue;
    const le = new Date(s.le);
    c.mesureLe = le;
    c.ruptureH = rupture && le >= rupture ? uneDecimale((le - rupture) / HEURE) : null;
    c.debutTravailH = debutTravail && le >= debutTravail ? uneDecimale((le - debutTravail) / HEURE) : null;
  }
  return {
    phaseArrivee: phaseArrivee(a),
    colonnes,
    // Affections survenues pendant la phase de latence, avec leurs traitements.
    affections: a.surveillances
      .filter((s) => (s.affection || s.traitements) && new Date(s.le).getTime() < fin)
      .sort((x, y) => x.le - y.le)
      .map((s) => ({ id: String(s._id), le: s.le, affection: s.affection, traitements: s.traitements })),
    evacuation: a.evacuation?.le ? { le: a.evacuation.le, motif: a.evacuation.motif, par: a.evacuation.par ?? null } : null,
  };
}

/** Partogramme d'un dossier d'accouchement (examen d'entrée compris), avec le tableau de la phase de latence. */
function duDossier(a) {
  const m = mesures(a);
  return { ...partogramme(m.surveillances, m.debutPhaseActive), latence: tableauLatence(a) };
}

/**
 * Alertes déclenchées par une nouvelle saisie. `alertesExistantes` évite de répéter la même
 * alerte de stagnation pendant un même épisode en zone jaune.
 */
function alertesDe(entree, surveillances, debutPhaseActive, alertesExistantes = []) {
  const alertes = [];
  if (bcfAnormal(entree.bcf)) {
    alertes.push({
      code: 'BCF', niveau: 'Critique', sonore: true,
      message: `BCF à ${entree.bcf} bpm : hors de la plage normale (${BCF.min}–${BCF.max} bpm).`,
    });
  }
  if (entree.phase !== 'Active' || entree.dilatationCm == null) return alertes;

  const points = pointsDilatation(surveillances, debutPhaseActive);
  const i = points.findIndex((p) => p.id === String(entree._id));
  if (i < 0) return alertes;
  const point = points[i];
  const precedent = points[i - 1];

  if (point.zone === 'Rouge' && precedent?.zone !== 'Rouge') {
    alertes.push({
      code: 'Zone rouge', niveau: 'Critique', sonore: true, notifierMedecins: true,
      message: `Dilatation à ${point.cm} cm après ${point.heures} h de phase active : la courbe a franchi la ligne d'action (zone rouge).`,
    });
  }
  if (point.zone === 'Jaune') {
    if (precedent?.zone !== 'Jaune') {
      alertes.push({
        code: 'Zone jaune', niveau: 'Avertissement', sonore: false,
        message: `Dilatation à ${point.cm} cm après ${point.heures} h de phase active : la courbe a franchi la ligne d'alerte (zone jaune).`,
      });
    }
    // Épisode jaune en cours : premier point de la série jaune ininterrompue.
    let debutEpisode = i;
    while (debutEpisode > 0 && points[debutEpisode - 1].zone === 'Jaune') debutEpisode -= 1;
    const reference = points.slice(debutEpisode, i).reverse().find((p) => point.le - p.le >= STAGNATION_H * HEURE);
    const dejaSignalee = alertesExistantes.some((a) => a.code === 'Stagnation' && a.le >= points[debutEpisode].le);
    if (reference && point.cm <= reference.cm && !dejaSignalee) {
      alertes.push({
        code: 'Stagnation', niveau: 'Critique', sonore: true,
        message: `Dilatation stationnaire à ${point.cm} cm depuis plus de ${STAGNATION_H} h en zone jaune.`,
      });
    }
  }
  return alertes;
}

module.exports = {
  BCF, PHASE_ACTIVE_CM, DILATATION_COMPLETE_CM, VITESSE_CM_H, DECALAGE_ACTION_H, STAGNATION_H,
  COLONNES_TABLEAU, COLONNES_LATENCE, zoneDilatation, bcfAnormal, partogramme, pointsDilatation, tableauHoraire, alertesDe, mesures, duDossier,
  ruptureLe, phaseArrivee, tableauLatence,
};
