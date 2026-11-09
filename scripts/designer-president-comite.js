// Désigne le président du comité de pilotage (seul à pouvoir retirer un membre).
// Un seul président à la fois : l'ancien président redevient simple membre.
// Usage : node scripts/designer-president-comite.js <email>
const mongoose = require('mongoose');

process.loadEnvFile();
const MembreComite = require('../models/MembreComite');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage : node scripts/designer-president-comite.js <email>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const membre = await MembreComite.findOne({ email });
  if (!membre) {
    console.error(`Aucun membre du comité n’a l’e-mail ${email}.`);
    process.exit(1);
  }
  const anciens = await MembreComite.find({ estPresident: true, _id: { $ne: membre._id } }).select('prenom nom email');
  await MembreComite.updateMany({ _id: { $ne: membre._id } }, { $set: { estPresident: false } });
  membre.estPresident = true;
  await membre.save();
  for (const a of anciens) console.log(`Ancien président redevenu membre : ${a.prenom} ${a.nom} <${a.email}>`);
  console.log(`Président du comité : ${membre.prenom} ${membre.nom} <${membre.email}>`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
