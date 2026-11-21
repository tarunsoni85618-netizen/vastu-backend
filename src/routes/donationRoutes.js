import { Router } from "express";
import { initiateDonation, getMyDonations } from "../controllers/donationController.js";
import { requireUser } from "../lib/auth.js";

const router = Router();

router.post("/initiate", initiateDonation);
router.get("/my-donations", requireUser, getMyDonations);

export default router;
