import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import Deployment from './src/modules/deployments/deployment.model.js';
import Mobilisation from './src/modules/mobilisations/mobilisation.model.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/aj-crm');
  const deps = await Deployment.find().populate('mobilisation').lean();
  console.log(deps.map(d => ({
    name: d.workerName,
    clientRate: d.mobilisation?.clientRate,
    otClientRate: d.mobilisation?.otClientRate,
    subcontractorRate: d.mobilisation?.subcontractorRate
  })));
  process.exit(0);
}
run();
