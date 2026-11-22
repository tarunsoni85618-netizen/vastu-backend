import { Router } from "express";
import {
  initiateDonation,
  verifyDonationPayment,
  getMyDonations,
} from "../controllers/donationController.js";
import { requireUser, optionalUser } from "../lib/auth.js";

const router = Router();

router.post("/initiate", initiateDonation);
router.post("/verify", verifyDonationPayment);
router.get("/my-donations", optionalUser, getMyDonations);

export default router;
