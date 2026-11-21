import { Router } from "express";
import {
  initiateAppointmentPayment,
  bookAppointment,
  getMyConsultations,
  getConsultationPricingHandler,
  getSingleConsultation,
  resolveLocationAndDistance,
} from "../controllers/consultationController.js";
import { requireUser } from "../lib/auth.js";

const router = Router();

router.get("/pricing", getConsultationPricingHandler);
router.get("/single", getSingleConsultation);
router.post("/resolve-location", resolveLocationAndDistance);
router.post("/", bookAppointment);
router.post("/initiate-payu", initiateAppointmentPayment);
router.get("/my", requireUser, getMyConsultations);

export default router;
