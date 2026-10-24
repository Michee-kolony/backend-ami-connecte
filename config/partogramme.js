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
  };
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
  zoneDilatation, bcfAnormal, partogramme, pointsDilatation, alertesDe,
};
