import { Router } from "express";
import { createTicket, getMyTickets } from "../controllers/ticketController.js";
import { requireUser, optionalUser } from "../lib/auth.js";

const router = Router();

router.post("/", createTicket);
router.get("/my", optionalUser, getMyTickets);

export default router;
