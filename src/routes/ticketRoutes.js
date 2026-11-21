import { Router } from "express";
import { createTicket, getMyTickets } from "../controllers/ticketController.js";
import { requireUser } from "../lib/auth.js";

const router = Router();

router.post("/", createTicket);
router.get("/my", requireUser, getMyTickets);

export default router;
