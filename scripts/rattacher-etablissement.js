// Cloisonnement entre établissements : les dossiers patientes, les ambulances et les chauffeurs
// enregistrés sans établissement ne sont plus visibles de personne. Ce script les liste, puis,
// avec --appliquer, les rattache à l'établissement donné (urgences et enfants suivent la patiente).
// Usage : node scripts/rattacher-etablissement.js            → bilan, sans rien modifier
//         node scripts/rattacher-etablissement.js <id> --appliquer
const mongoose = require('mongoose');

process.loadEnvFile();
const Etablissement = require('../models/Etablissement');
const Patiente = require('../models/Patiente');
const Ambulance = require('../models/Ambulance');
const Chauffeur = require('../models/Chauffeur');
const Urgence = require('../models/Urgence');

const SANS = { etablissementId: { $in: [null, ''] } };

async function main() {
  const [etablissementId, option] = process.argv.slice(2);
  await mongoose.connect(process.env.MONGODB_URI);

  const [patientes, ambulances, chauffeurs, urgences] = await Promise.all([
    Patiente.find(SANS).select('numero nom prenom').lean(),
    Ambulance.find(SANS).select('code immatriculation').lean(),
    Chauffeur.find(SANS).select('matricule nom prenom').lean(),
    Urgence.countDocuments(SANS),
  ]);
  console.log(`Sans établissement : ${patientes.length} patiente(s), ${ambulances.length} ambulance(s), ${chauffeurs.length} chauffeur(s), ${urgences} urgence(s).`);
  for (const p of patientes) console.log(`  patiente  ${p.numero} ${p.prenom} ${p.nom}`);
  for (const a of ambulances) console.log(`  ambulance ${a.code} ${a.immatriculation}`);
  for (const c of chauffeurs) console.log(`  chauffeur ${c.matricule} ${c.prenom} ${c.nom}`);

  if (option !== '--appliquer') {
    const liste = await Etablissement.find().select('nom province statut').sort({ nom: 1 }).lean();
    console.log('\nÉtablissements :');
    for (const e of liste) console.log(`  ${e._id}  ${e.nom} (${e.province}, ${e.statut})`);
    console.log('\nPour rattacher : node scripts/rattacher-etablissement.js <id> --appliquer');
    return mongoose.disconnect();
  }

  const etablissement = mongoose.isValidObjectId(etablissementId) && await Etablissement.findById(etablissementId);
  if (!etablissement) throw new Error(`Établissement introuvable : ${etablissementId}`);
  const id = etablissement.id;
  const ids = patientes.map((p) => p._id);
  const [p, a, c, u] = await Promise.all([
    Patiente.updateMany({ _id: { $in: ids } }, { etablissementId: id }),
    Ambulance.updateMany(SANS, { etablissementId: id }),
    Chauffeur.updateMany(SANS, { etablissementId: id }),
    Urgence.updateMany({ ...SANS, patienteId: { $in: ids } }, { etablissementId: id }),
  ]);
  console.log(`Rattachés à « ${etablissement.nom} » : ${p.modifiedCount} patiente(s), ${a.modifiedCount} ambulance(s), ${c.modifiedCount} chauffeur(s), ${u.modifiedCount} urgence(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
