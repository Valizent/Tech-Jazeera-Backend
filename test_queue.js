import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import { getPendingHoursQueue } from './src/modules/deployments/deployment.service.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/aj-crm');
  const queue = await getPendingHoursQueue({ role: 'Admin', sectionAccessWrite: ['deploymentsHoursDecide'] });
  console.log(JSON.stringify(queue.map(q => ({
    name: q.workerName,
    clientInvoiceAmount: q.profitBreakdown?.clientInvoiceAmount,
    revenue: q.revenue,
    profit: q.profit,
    profitBreakdown: q.profitBreakdown
  })), null, 2));
  process.exit(0);
}
run();
