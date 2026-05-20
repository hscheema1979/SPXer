// Stub for ticker-routes (real implementation never committed; the import
// in http.ts is committed). Empty router so the app boots; the
// /api/tickers/* endpoints just 404 until the real impl is restored.

import { Router } from 'express'

export const tickerRoutes: Router = Router()
