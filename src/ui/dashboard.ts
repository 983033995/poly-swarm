import { reportDashboardError, startDashboard } from "./app.js";

void startDashboard().catch(reportDashboardError);
