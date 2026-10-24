// Rappels push quotidiens à la mère (vérifiés toutes les 30 minutes, envoyés entre 8 h et 20 h,
// heure de Kinshasa) :
//   - rendez-vous (les siens et ceux de ses enfants) : la veille, puis le matin même, une fois chacun ;
//   - vaccination de l'enfant sans rendez-vous programmé : la veille de la séance prévue, puis
//     chaque semaine tant qu'une dose attendue n'est pas faite.
// Le médecin peut aussi envoyer à la demande le rappel du prochain rendez-vous de chaque patiente
// (bouton de l'agenda, voir rappelerProchainsRendezVous).
const RendezVous = require('../models/RendezVous');
const Patiente = require('../models/Patiente');
const Enfant = require('../models/Enfant');
const { notifierPatiente } = require('./notifications');
const { jourKinshasa } = require('./vaccination');

const JOUR = 86400000;
const INTERVALLE_MS = 30 * 60000;
const HEURES_ENVOI = [8, 20];
/** Dose attendue non faite : rappel répété tous les 7 jours. */
const RELANCE_VACCIN_JOURS = 7;
/** Rappel à la demande : rendez-vous des 30 prochains jours. */
const HORIZON_MANUEL_JOURS = 30;
/** Âge au-delà duquel l'enfant n'a plus de dose au calendrier (59 mois). */
const AGE_MAX_JOURS = 1830;

/** Début (instant UTC) du jour civil de Kinshasa donné (UTC+1). */
const debutJour = (jour) => new Date(`${jour}T00:00:00+01:00`);
// formatToParts : en français, format() donne « 21 h », que Number() ne lit pas.
const heureKinshasa = (d) => Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Kinshasa', hour: 'numeric', hourCycle: 'h23' })
  .formatToParts(d).find((p) => p.type === 'hour').value);
const heureLisible = (d) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Kinshasa', hour: '2-digit', minute: '2-digit' }).format(d);
const pourEnfant = (rdv) => (rdv.enfantId ? ' de votre enfant' : '');

/**
 * Rendez-vous d'aujourd'hui (rappel du matin) et de demain (rappel de la veille). Le champ de
 * suivi est marqué avant l'envoi : deux serveurs ne notifient jamais deux fois.
 */
async function rappelerRendezVous(maintenant) {
  const demain = debutJour(jourKinshasa(new Date(maintenant.getTime() + JOUR)));
  const tournees = [
    {
      du: maintenant, au: demain, champ: 'rappelJourPushLe',
      titre: (r) => `Rendez-vous${pourEnfant(r)} aujourd’hui`,
      corps: (r) => `Aujourd’hui à ${heureLisible(r.date)}. N’oubliez pas votre carnet.`,
    },
    {
      du: demain, au: new Date(demain.getTime() + JOUR), champ: 'rappelPushLe',
      titre: (r) => `Rappel : rendez-vous${pourEnfant(r)} demain`,
      corps: (r) => `Le ${RendezVous.dateLisible(r.date)}. N’oubliez pas votre carnet.`,
    },
  ];
  let envoyes = 0;
  for (const t of tournees) {
    const rdvs = await RendezVous.find({ date: { $gte: t.du, $lt: t.au }, statut: { $in: RendezVous.STATUTS_ACTIFS }, [t.champ]: null });
    for (const rdv of rdvs) {
      // updateOne : marque le rappel sans repasser par les notifications du modèle.
      const { modifiedCount } = await RendezVous.updateOne({ _id: rdv._id, [t.champ]: null }, { [t.champ]: maintenant });
      if (!modifiedCount) continue;
      const ok = await notifierPatiente(rdv.patienteId, {
        titre: t.titre(rdv), corps: t.corps(rdv), donnees: { type: 'rendez-vous', rendezVousId: rdv.id },
      });
      if (ok) envoyes += 1;
    }
  }
  return envoyes;
}

/**
 * Vaccination des enfants suivis dont la mère a l'application : séance prévue demain, ou dose
 * attendue (à faire, en retard). Un enfant qui a déjà un rendez-vous à venir est rappelé par son
 * rendez-vous. Au plus un rappel par enfant et par jour (rappelVaccinJour).
 */
async function rappelerVaccinations(maintenant) {
  const jour = jourKinshasa(maintenant);
  const demain = jourKinshasa(new Date(maintenant.getTime() + JOUR));
  const meres = await Patiente.find({ espaceEnLigne: 'Activé', 'appareils.0': { $exists: true } }).select('_id');
  if (!meres.length) return 0;
  const enfants = await Enfant.find({
    mereId: { $in: meres.map((m) => m._id) }, statut: 'Suivi', etatNaissance: 'Vivant',
    dateNaissance: { $gte: jourKinshasa(new Date(maintenant.getTime() - AGE_MAX_JOURS * JOUR)) },
    rappelVaccinJour: { $ne: jour },
  });
  if (!enfants.length) return 0;
  const avecRdv = new Set((await RendezVous.find({
    enfantId: { $in: enfants.map((e) => e._id) }, statut: { $in: RendezVous.STATUTS_ACTIFS }, date: { $gte: debutJour(jour) },
  }).select('enfantId')).map((r) => String(r.enfantId)));
  const relance = jourKinshasa(new Date(maintenant.getTime() - RELANCE_VACCIN_JOURS * JOUR));

  let envoyes = 0;
  for (const e of enfants) {
    if (avecRdv.has(e.id)) continue;
    const seance = e.carnet(jour)?.prochaineSeance;
    if (!seance) continue;
    const qui = e.prenom || 'Votre enfant';
    let contenu = null;
    if (seance.date === demain) {
      contenu = { titre: 'Vaccination prévue demain', corps: `${qui} a une séance de vaccination prévue demain. Pensez au carnet de vaccination.` };
    } else if (seance.date <= jour && (!e.rappelVaccinJour || e.rappelVaccinJour <= relance)) {
      contenu = seance.doses.some((d) => d.statut === 'En retard')
        ? { titre: 'Vaccination en retard', corps: `Une vaccination de ${e.prenom || 'votre enfant'} est en retard. Rendez-vous au centre de santé avec le carnet.` }
        : { titre: 'Vaccination à faire', corps: `${qui} doit recevoir une vaccination. Rendez-vous au centre de santé avec le carnet.` };
    }
    if (!contenu) continue;
    const { modifiedCount } = await Enfant.updateOne({ _id: e._id, rappelVaccinJour: e.rappelVaccinJour ?? null }, { rappelVaccinJour: jour });
    if (!modifiedCount) continue;
    if (await notifierPatiente(e.mereId, { ...contenu, donnees: { type: 'vaccination', enfantId: e.id } })) envoyes += 1;
  }
  return envoyes;
}

/** Tournée des rappels (entre 8 h et 20 h) ; renvoie le nombre de notifications envoyées. */
async function envoyerRappels(maintenant = new Date()) {
  const heure = heureKinshasa(maintenant);
  if (heure < HEURES_ENVOI[0] || heure >= HEURES_ENVOI[1]) return 0;
  return (await rappelerRendezVous(maintenant)) + (await rappelerVaccinations(maintenant));
}

/**
 * Rappel à la demande (bouton de l'agenda) : chaque patiente ayant un rendez-vous attendu dans
 * les 30 prochains jours reçoit la date de son prochain rendez-vous (le sien ou celui d'un enfant).
 */
async function rappelerProchainsRendezVous(maintenant = new Date()) {
  const rdvs = await RendezVous.find({
    date: { $gte: maintenant, $lt: new Date(maintenant.getTime() + HORIZON_MANUEL_JOURS * JOUR) },
    statut: { $in: RendezVous.STATUTS_ACTIFS },
  }).sort({ date: 1 });
  const parPatiente = new Map();
  for (const r of rdvs) {
    const id = String(r.patienteId);
    if (!parPatiente.has(id)) parPatiente.set(id, []);
    parPatiente.get(id).push(r);
  }
  let notifiees = 0;
  for (const [patienteId, [prochain, ...suivants]] of parPatiente) {
    const n = suivants.length;
    const ensuite = n ? ` ${n} autre${n > 1 ? 's' : ''} rendez-vous prévu${n > 1 ? 's' : ''} ensuite.` : '';
    const ok = await notifierPatiente(patienteId, {
      titre: `Rappel : prochain rendez-vous${pourEnfant(prochain)}`,
      corps: `Le ${RendezVous.dateLisible(prochain.date)}.${ensuite} Ouvrez l’application pour les détails.`,
      donnees: { type: 'rendez-vous', rendezVousId: prochain.id },
    });
    if (ok) notifiees += 1;
  }
  return { rendezVous: rdvs.length, patientes: parPatiente.size, notifiees };
}

function demarrer() {
  const tour = () => envoyerRappels().catch((err) => console.error('Rappels push :', err.message));
  setTimeout(tour, 60000);
  return setInterval(tour, INTERVALLE_MS);
}

module.exports = { envoyerRappels, rappelerProchainsRendezVous, demarrer, HORIZON_MANUEL_JOURS };
