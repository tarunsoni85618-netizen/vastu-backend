import { Router } from "express";
import {
  initiateAppointmentPayment,
  verifyAppointmentPayment,
  bookAppointment,
  getMyConsultations,
  getConsultationPricingHandler,
  getSingleConsultation,
  resolveLocationAndDistance,
} from "../controllers/consultationController.js";
import { requireUser, optionalUser } from "../lib/auth.js";

const router = Router();

router.get("/pricing", getConsultationPricingHandler);
router.get("/single", getSingleConsultation);
router.post("/resolve-location", resolveLocationAndDistance);
router.post("/", requireUser, bookAppointment);
router.post("/initiate-payment", requireUser, initiateAppointmentPayment);
router.post("/initiate-payu", requireUser, initiateAppointmentPayment); // legacy alias
router.post("/verify-payment", requireUser, verifyAppointmentPayment);
router.get("/my", optionalUser, getMyConsultations);

export default router;
