import mongoose from "mongoose";
import { connectDB } from "../lib/dbConnect.js";
import Consultation from "../models/Consultation.js";
import Service from "../models/Service.js";
import StoreSettings from "../models/StoreSettings.js";
import { generatePayUHash, getPayUEndpoint } from "../lib/payu.js";

const allowedStatuses = {
  status: ["pending", "confirmed", "completed", "cancelled"],
  paymentStatus: ["pending", "paid", "failed", "refunded"],
  mode: ["online", "in_person", "phone"],
};

export const DEFAULT_CONSULTATION_PRICING = {
  videoCall: 2100,
  officeVisit: 2100,
  withinJaipur: 11000,
  within500km: 21000,
  above500km: 31000,
  // Legacy fields preserved for backward compatibility
  within200km: 21000,
  within200_300km: 21000,
  above300km: 31000,
  gstRate: 18, // 18%, 5%, or 0%
  gstin: "08ABCDE1234F1Z5",
};

// Haversine formula to compute distance in km
export function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of earth in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// Retrieve live dynamic pricing from StoreSettings
export async function getConsultationPricing() {
  try {
    await connectDB();
    const settings = await StoreSettings.findOne({ key: "main" }).lean();
    const p = settings?.consultations?.pricing || {};
    return {
      videoCall: Number(p.videoCall ?? DEFAULT_CONSULTATION_PRICING.videoCall),
      officeVisit: Number(p.officeVisit ?? DEFAULT_CONSULTATION_PRICING.officeVisit),
      withinJaipur: Number(p.withinJaipur ?? DEFAULT_CONSULTATION_PRICING.withinJaipur),
      within500km: Number(p.within500km ?? p.within200km ?? DEFAULT_CONSULTATION_PRICING.within500km),
      above500km: Number(p.above500km ?? p.above300km ?? DEFAULT_CONSULTATION_PRICING.above500km),
      within200km: Number(p.within500km ?? p.within200km ?? DEFAULT_CONSULTATION_PRICING.within200km),
      within200_300km: Number(p.within500km ?? p.within200_300km ?? DEFAULT_CONSULTATION_PRICING.within200_300km),
      above300km: Number(p.above500km ?? p.above300km ?? DEFAULT_CONSULTATION_PRICING.above300km),
      gstRate: [0, 5, 18].includes(Number(p.gstRate)) ? Number(p.gstRate) : DEFAULT_CONSULTATION_PRICING.gstRate,
      gstin: String(p.gstin ?? DEFAULT_CONSULTATION_PRICING.gstin),
    };
  } catch (err) {
    console.error("Failed to fetch consultation pricing from settings:", err);
    return DEFAULT_CONSULTATION_PRICING;
  }
}

// Public API handler for consultation pricing
export async function getConsultationPricingHandler(req, res) {
  try {
    const data = await getConsultationPricing();
    return res.json({ success: true, data });
  } catch {
    return res.json({ success: true, data: DEFAULT_CONSULTATION_PRICING });
  }
}

// Admin API handler to update consultation pricing and GST rate
export async function updateConsultationPricingHandler(req, res) {
  try {
    await connectDB();
    const body = req.body || {};
    const within500km = Math.max(0, Number(body.within500km ?? body.within200km ?? DEFAULT_CONSULTATION_PRICING.within500km));
    const above500km = Math.max(0, Number(body.above500km ?? body.above300km ?? DEFAULT_CONSULTATION_PRICING.above500km));

    const pricingToSave = {
      videoCall: Math.max(0, Number(body.videoCall ?? DEFAULT_CONSULTATION_PRICING.videoCall)),
      officeVisit: Math.max(0, Number(body.officeVisit ?? DEFAULT_CONSULTATION_PRICING.officeVisit)),
      withinJaipur: Math.max(0, Number(body.withinJaipur ?? DEFAULT_CONSULTATION_PRICING.withinJaipur)),
      within500km,
      above500km,
      // Mirror to legacy keys for full compatibility
      within200km: within500km,
      within200_300km: within500km,
      above300km: above500km,
      gstRate: [0, 5, 18].includes(Number(body.gstRate)) ? Number(body.gstRate) : 18,
      gstin: String(body.gstin ?? "").trim(),
    };

    let settings = await StoreSettings.findOne({ key: "main" });
    if (!settings) {
      settings = new StoreSettings({ key: "main", consultations: {} });
    }
    if (!settings.consultations) {
      settings.consultations = {};
    }
    settings.consultations.pricing = pricingToSave;
    settings.markModified("consultations");
    await settings.save();

    return res.json({
      success: true,
      message: "Consultation fees and GST rate updated successfully",
      data: pricingToSave,
    });
  } catch (err) {
    console.error("updateConsultationPricingHandler error:", err);
    return res.status(500).json({ success: false, error: "Failed to update consultation pricing" });
  }
}

export function calculateAppointmentFee({ consultationMode, distanceTier, pricing = DEFAULT_CONSULTATION_PRICING }) {
  if (consultationMode === "video_call") return pricing.videoCall;
  if (consultationMode === "office_visit") return pricing.officeVisit;
  switch (distanceTier) {
    case "within_jaipur":
      return pricing.withinJaipur || 11000;
    case "within_500km":
    case "within_200km":
    case "within_200_300km":
      return pricing.within500km || pricing.within200km || 21000;
    case "above_500km":
    case "above300km":
    case "above_300km":
      return pricing.above500km || pricing.above300km || 31000;
    default:
      return pricing.withinJaipur || 11000;
  }
}

// Calculate distance & tier from Google Map link or coordinates
export async function resolveLocationAndDistance(req, res) {
  try {
    const { googleMapsLink, lat, lng, locationText } = req.body || {};
    let targetLat = null;
    let targetLng = null;
    let resolvedLabel = "";

    // 1. Coordinates directly supplied (e.g. from GPS navigator.geolocation)
    if (lat !== undefined && lng !== undefined && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng))) {
      targetLat = Number(lat);
      targetLng = Number(lng);
      resolvedLabel = `Current Location (${targetLat.toFixed(4)}, ${targetLng.toFixed(4)})`;
    }

    // 2. Extract coordinates from Google Maps Link if not set
    if ((targetLat === null || targetLng === null) && googleMapsLink) {
      const link = String(googleMapsLink).trim();

      const atMatch = link.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      const qMatch = link.match(/[?&](?:q|ll|daddr)=(-?\d+\.\d+),(-?\d+\.\d+)/);
      const rawMatch = link.match(/^(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)$/);

      if (atMatch) {
        targetLat = parseFloat(atMatch[1]);
        targetLng = parseFloat(atMatch[2]);
      } else if (qMatch) {
        targetLat = parseFloat(qMatch[1]);
        targetLng = parseFloat(qMatch[2]);
      } else if (rawMatch) {
        targetLat = parseFloat(rawMatch[1]);
        targetLng = parseFloat(rawMatch[2]);
      } else if (link.includes("maps.app.goo.gl") || link.includes("goo.gl/maps")) {
        try {
          const resp = await fetch(link, { method: "HEAD", redirect: "follow" });
          const finalUrl = resp.url || "";
          const expAtMatch = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
          const expQMatch = finalUrl.match(/[?&](?:q|ll|daddr)=(-?\d+\.\d+),(-?\d+\.\d+)/);
          if (expAtMatch) {
            targetLat = parseFloat(expAtMatch[1]);
            targetLng = parseFloat(expAtMatch[2]);
          } else if (expQMatch) {
            targetLat = parseFloat(expQMatch[1]);
            targetLng = parseFloat(expQMatch[2]);
          }
        } catch (e) {
          console.warn("Failed to expand short Google Maps link:", e.message);
        }
      }
    }

    // 3. Fallback: Search via OpenStreetMap geocoding if text address given
    if ((targetLat === null || targetLng === null) && (locationText || googleMapsLink)) {
      const query = String(locationText || googleMapsLink)
        .replace(/https?:\/\/[^\s]+/g, "")
        .trim();
      if (query.length >= 2) {
        try {
          const geoResp = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ", India")}&limit=1`,
            { headers: { "User-Agent": "BhuwneshwariScientificVastu/1.0" } }
          );
          const geoJson = await geoResp.json();
          if (Array.isArray(geoJson) && geoJson.length > 0) {
            targetLat = parseFloat(geoJson[0].lat);
            targetLng = parseFloat(geoJson[0].lon);
            resolvedLabel = geoJson[0].display_name;
          }
        } catch {}
      }
    }

    if (targetLat === null || targetLng === null) {
      return res.status(400).json({
        success: false,
        error: "Unable to detect coordinates from the provided link or location. Please allow GPS location access or paste a direct Google Maps link with coordinates.",
      });
    }

    // Jaipur City Center Benchmark:  
    const JAIPUR_LAT = 26.9517588;
    const JAIPUR_LNG = 75.7074103;
    const distanceKm = getDistanceFromLatLonInKm(JAIPUR_LAT, JAIPUR_LNG, targetLat, targetLng);

    const pricing = await getConsultationPricing();

    let distanceTier = "within_jaipur";
    let tierTitle = "In Jaipur City (within 40 km)";
    let fee = pricing.withinJaipur;

    if (distanceKm <= 40) {
      distanceTier = "within_jaipur";
      tierTitle = "In Jaipur City (within 40 km)";
      fee = pricing.withinJaipur;
    } else if (distanceKm <= 500) {
      distanceTier = "within_500km";
      tierTitle = `Outside Jaipur, Within 500 km (~${distanceKm} km)`;
      fee = pricing.within500km;
    } else {
      distanceTier = "above_500km";
      tierTitle = `Above 500 km from Jaipur (~${distanceKm} km)`;
      fee = pricing.above500km;
    }

    return res.json({
      success: true,
      data: {
        distanceKm,
        distanceTier,
        tierTitle,
        fee,
        lat: targetLat,
        lng: targetLng,
        resolvedLabel: resolvedLabel || `${distanceKm} km from Jaipur Center`,
        googleMapsLink: googleMapsLink || `https://www.google.com/maps?q=${targetLat},${targetLng}`,
      },
    });
  } catch (error) {
    console.error("resolveLocationAndDistance error:", error);
    return res.status(500).json({ success: false, error: "Failed to calculate location distance" });
  }
}

// Get single consultation for GST Invoice / Details
export async function getSingleConsultation(req, res) {
  try {
    await connectDB();
    const { reference, id, txnid } = req.query;
    const filter = {};
    if (reference) filter.reference = reference;
    else if (id && mongoose.isValidObjectId(id)) filter._id = id;
    else if (txnid) filter.txnid = txnid;
    else {
      return res.status(400).json({ success: false, error: "Reference, id, or txnid is required" });
    }

    const consultation = await Consultation.findOne(filter).lean();
    if (!consultation) {
      return res.status(404).json({ success: false, error: "Consultation booking not found" });
    }

    // Attach GST calculation breakdown
    const totalAmount = Number(consultation.amount || 0);
    const gstRate = Number(consultation.gstRate ?? 18);
    let taxableAmount = 0;
    let gstAmount = 0;
    if (gstRate > 0) {
      taxableAmount = Math.round((totalAmount / (1 + gstRate / 100)) * 100) / 100;
      gstAmount = Math.round((totalAmount - taxableAmount) * 100) / 100;
    } else {
      taxableAmount = totalAmount;
      gstAmount = 0;
    }

    const clientState = String(consultation.state || "Rajasthan").trim();
    const isIntraState = !clientState || clientState.toLowerCase().includes("rajasthan");

    let cgstRate = 0;
    let sgstRate = 0;
    let igstRate = 0;
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    if (gstRate > 0) {
      if (isIntraState) {
        cgstRate = gstRate / 2;
        sgstRate = gstRate / 2;
        cgstAmount = Math.round((gstAmount / 2) * 100) / 100;
        sgstAmount = Math.round((gstAmount - cgstAmount) * 100) / 100;
      } else {
        igstRate = gstRate;
        igstAmount = gstAmount;
      }
    }

    const invoiceData = {
      ...consultation,
      state: clientState,
      isIntraState,
      taxableAmount,
      gstAmount,
      gstRate,
      cgstRate,
      sgstRate,
      igstRate,
      cgstAmount,
      sgstAmount,
      igstAmount,
      sacCode: "998399",
      invoiceNumber: `INV-${consultation.reference || consultation._id}`,
      firmName: "Bhuwneshwari Scientific Vastu",
      firmAddress: "Jaipur, Rajasthan, India",
      firmGstin: consultation.gstin || "08ABCDE1234F1Z5",
      firmState: "Rajasthan (State Code: 08)",
      firmPhone: "+91 8690708302",
      firmEmail: "support@bhuwneshwari.com",
    };

    return res.json({ success: true, data: invoiceData });
  } catch (error) {
    console.error("getSingleConsultation error:", error);
    return res.status(500).json({ success: false, error: "Unable to retrieve consultation details" });
  }
}

export async function getConsultations(req, res) {
  try {
    await connectDB();
    const status = req.query.status;
    const filter = status ? { status } : {};
    const data = await Consultation.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, error: "Unable to fetch consultations" });
  }
}

export async function getMyConsultations(req, res) {
  try {
    await connectDB();
    if (!req.user) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const rawPhone = String(req.user?.phone || "").replace(/\D/g, "");
    const email = String(req.user?.email || "").trim().toLowerCase();

    const conditions = [];
    if (rawPhone.length >= 10) {
      conditions.push({ phone: { $regex: new RegExp(rawPhone.slice(-10) + "$") } });
      conditions.push({ userPhone: { $regex: new RegExp(rawPhone.slice(-10) + "$") } });
    }
    if (email) {
      conditions.push({ email });
    }

    if (conditions.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const data = await Consultation.find({ $or: conditions })
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json({ success: true, data });
  } catch (error) {
    console.error("getMyConsultations error:", error);
    return res.status(500).json({ success: false, error: "Unable to retrieve consultations" });
  }
}

export async function initiateAppointmentPayment(req, res) {
  try {
    await connectDB();
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Please login with your mobile number to book a consultation.",
      });
    }
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").replace(/\D/g, "");
    const email = String(body.email || "").trim().toLowerCase();
    const serviceName = String(body.service || "").trim();
    const serviceId = body.serviceId;
    const consultationMode = String(body.consultationMode || "site_visit");
    const distanceTier = String(body.distanceTier || "within_jaipur");
    const googleMapsLink = String(body.googleMapsLink || "").trim();
    const distanceKm = Number(body.distanceKm) || null;
    const dateStr = String(body.date || "");
    const time = String(body.time || "10:00 AM");

    // Client and Reference details
    const reference = `BSV-APT-${Date.now().toString().slice(-8)}`;
    const documentNo = reference;
    const clientId = String(body.clientId || (phone ? `CLT-${phone.slice(-6)}` : `CLT-${Date.now().toString().slice(-6)}`));

    // PDF registration fields
    const fatherOrSpouseName = String(body.fatherOrSpouseName || "").trim();
    const residentialAddress = String(body.residentialAddress || body.address1 || "").trim();
    const state = String(body.state || "Rajasthan").trim();
    const occupation = String(body.occupation || "").trim();
    const propertyOwnerName = String(body.propertyOwnerName || name).trim();
    const propertyAddress = String(body.propertyAddress || body.address1 || "").trim();
    const propertyType = String(body.propertyType || "Residential");
    const approximateArea = String(body.approximateArea || "").trim();
    const numberOfFloors = String(body.numberOfFloors || "1").trim();
    const propertyPlanProvided = Boolean(body.propertyPlanProvided);
    const siteVisitRequired = consultationMode === "site_visit";
    const clientConcerns = String(body.clientConcerns || body.notes || "").trim();
    const clientGstin = String(body.clientGstin || "").trim().toUpperCase();
    const familyMembers = Array.isArray(body.familyMembers) ? body.familyMembers : [];

    if (!name || phone.length < 10 || !email) {
      return res.status(400).json({
        success: false,
        error: "Valid full name, email, and 10-digit mobile number are required.",
      });
    }

    if (!serviceName) {
      return res.status(400).json({
        success: false,
        error: "Please select a consultation service.",
      });
    }

    // Dynamic fee calculation from admin-configured pricing
    const pricing = await getConsultationPricing();
    let fee = 0;
    if (consultationMode === "video_call") {
      fee = pricing.videoCall;
    } else if (consultationMode === "office_visit") {
      fee = pricing.officeVisit;
    } else {
      switch (distanceTier) {
        case "within_jaipur":
          fee = pricing.withinJaipur || 11000;
          break;
        case "within_500km":
        case "within_200km":
        case "within_200_300km":
          fee = pricing.within500km || pricing.within200km || 21000;
          break;
        case "above_500km":
        case "above_300km":
          fee = pricing.above500km || pricing.above300km || 31000;
          break;
        default:
          fee = pricing.withinJaipur || 11000;
      }
    }

    // GST calculation
    const gstRate = Number(pricing.gstRate ?? 18);
    let taxableAmount = 0;
    let gstAmount = 0;
    if (gstRate > 0) {
      taxableAmount = Math.round((fee / (1 + gstRate / 100)) * 100) / 100;
      gstAmount = Math.round((fee - taxableAmount) * 100) / 100;
    } else {
      taxableAmount = fee;
      gstAmount = 0;
    }

    // Date & Time: user no longer picks date; admin calls client and schedules date & time
    let dateVal = null;
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!Number.isNaN(parsed.getTime())) dateVal = parsed;
    }
    const finalTime = body.time ? String(body.time) : "To be scheduled";
    const txnid = `TXN_APT_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const consultation = await Consultation.create({
      reference,
      documentNo,
      clientId,
      customer: mongoose.isValidObjectId(req.user?._id || req.user?.id)
        ? (req.user._id || req.user.id)
        : undefined,
      name,
      fatherOrSpouseName,
      email,
      phone,
      userPhone: req.user?.phone ? String(req.user.phone).replace(/\D/g, "") : phone,
      residentialAddress,
      state,
      occupation,
      type: serviceName,
      serviceId: mongoose.isValidObjectId(serviceId) ? serviceId : undefined,
      consultationMode,
      distanceTier,
      googleMapsLink,
      distanceKm,
      mode: consultationMode === "video_call" ? "online" : "in_person",
      date: dateVal,
      time: finalTime,
      scheduledDate: null,
      scheduledTime: "",
      scheduledByAdmin: false,
      gstRate,
      gstAmount,
      taxableAmount,
      gstin: pricing.gstin || "",
      clientGstin,
      propertyOwnerName,
      propertyAddress,
      propertyType,
      approximateArea,
      numberOfFloors,
      propertyPlanProvided,
      siteVisitRequired,
      clientConcerns,
      familyMembers,
      declarationAccepted: true,
      address: propertyAddress || residentialAddress,
      notes: clientConcerns,
      amount: fee,
      status: "pending",
      paymentStatus: "pending",
      txnid,
    });

    const successUrl = process.env.PAYU_SUCCESS_URL || "http://localhost:3001/api/payments/payu/response";
    const failureUrl = process.env.PAYU_FAILURE_URL || "http://localhost:3001/api/payments/payu/response";

    const hash = generatePayUHash({
      txnid,
      amount: fee,
      productinfo: serviceName.substring(0, 50),
      firstname: name.split(" ")[0] || "Client",
      email,
      udf1: reference,
      udf2: "appointment",
      udf3: phone,
      udf4: "",
      udf5: "",
    });

    return res.json({
      success: true,
      reference,
      documentNo,
      clientId,
      appointmentId: consultation._id,
      amount: fee,
      payuData: {
        key: process.env.PAYU_KEY || "m6wAnh",
        txnid,
        amount: Number(fee).toFixed(2),
        productinfo: serviceName.substring(0, 50),
        firstname: name.split(" ")[0] || "Client",
        email,
        phone,
        surl: successUrl,
        furl: failureUrl,
        udf1: reference,
        udf2: "appointment",
        udf3: phone,
        udf4: "",
        udf5: "",
        hash,
        action: getPayUEndpoint(),
      },
    });
  } catch (error) {
    console.error("initiateAppointmentPayment error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to initiate payment for appointment.",
    });
  }
}

export async function bookAppointment(req, res) {
  return initiateAppointmentPayment(req, res);
}

export async function createConsultation(req, res) {
  try {
    const b = req.body;
    if (!b.name?.trim() || !b.type || !b.date) {
      return res.status(400).json({
        success: false,
        error: "Name, consultation type and date are required",
      });
    }

    await connectDB();
    const reference = `BSV-APT-${Date.now().toString().slice(-8)}`;
    const phone = String(b.phone || "").replace(/\D/g, "");

    const data = await Consultation.create({
      reference,
      documentNo: reference,
      clientId: b.clientId || (phone ? `CLT-${phone.slice(-6)}` : "CLT-ADMIN"),
      name: b.name.trim(),
      email: String(b.email || "").toLowerCase(),
      phone: String(b.phone || ""),
      userPhone: phone,
      type: String(b.type),
      mode: ["online", "in_person", "phone"].includes(b.mode) ? b.mode : "online",
      date: new Date(b.date),
      time: String(b.time || "10:00 AM"),
      notes: String(b.notes || ""),
      amount: Math.max(0, Number(b.amount) || 0),
      status: b.status || "pending",
      paymentStatus: b.paymentStatus || "pending",
      address: String(b.address || ""),
      propertyAddress: String(b.propertyAddress || b.address || ""),
      propertyType: String(b.propertyType || "Residential"),
      clientConcerns: String(b.notes || ""),
    });

    return res.status(201).json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, error: "Unable to create consultation" });
  }
}

export async function updateConsultation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid consultation id" });
    }

    const b = req.body;
    const update = {};

    for (const [key, values] of Object.entries(allowedStatuses)) {
      if (b[key] !== undefined) {
        if (!values.includes(b[key])) {
          return res.status(400).json({ success: false, error: `Invalid ${key}` });
        }
        update[key] = b[key];
      }
    }

    for (const key of [
      "name",
      "fatherOrSpouseName",
      "email",
      "phone",
      "residentialAddress",
      "state",
      "occupation",
      "type",
      "time",
      "address",
      "propertyOwnerName",
      "propertyAddress",
      "propertyType",
      "approximateArea",
      "numberOfFloors",
      "clientConcerns",
      "notes",
      "googleMapsLink",
      "distanceTier",
      "clientGstin",
    ]) {
      if (b[key] !== undefined) update[key] = String(b[key]);
    }

    if (b.distanceKm !== undefined) update.distanceKm = Number(b.distanceKm);
    if (b.propertyPlanProvided !== undefined) update.propertyPlanProvided = Boolean(b.propertyPlanProvided);
    if (b.phone) update.userPhone = String(b.phone).replace(/\D/g, "");

    if (b.date !== undefined && b.date) {
      const date = new Date(b.date);
      if (!Number.isNaN(date.getTime())) {
        update.date = date;
      }
    }

    if (b.scheduledDate !== undefined && b.scheduledDate) {
      const sDate = new Date(b.scheduledDate);
      if (!Number.isNaN(sDate.getTime())) {
        update.scheduledDate = sDate;
        update.date = sDate;
        update.scheduledByAdmin = true;
      }
    }

    if (b.scheduledTime !== undefined) {
      update.scheduledTime = String(b.scheduledTime);
      update.time = String(b.scheduledTime);
      update.scheduledByAdmin = true;
    }

    if (b.scheduledByAdmin !== undefined) {
      update.scheduledByAdmin = Boolean(b.scheduledByAdmin);
    }

    if (b.gstRate !== undefined) {
      update.gstRate = Number(b.gstRate);
    }

    if (b.amount !== undefined) {
      update.amount = Math.max(0, Number(b.amount) || 0);
    }

    await connectDB();
    const existing = await Consultation.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: "Consultation not found" });
    }

    // Protection: Once marked "completed", consultation status cannot be changed
    if (existing.status === "completed" && update.status && update.status !== "completed") {
      delete update.status;
    }

    // Protection: If payment is already completed/paid, it cannot be reverted
    if (existing.paymentStatus === "paid" && update.paymentStatus && update.paymentStatus !== "paid") {
      delete update.paymentStatus;
    }

    // Keep GST calculations in sync if fee or rate was updated
    const finalAmount = update.amount !== undefined ? update.amount : existing.amount;
    const finalGstRate = update.gstRate !== undefined ? update.gstRate : (existing.gstRate ?? 18);
    if (update.amount !== undefined || update.gstRate !== undefined) {
      if (finalGstRate > 0) {
        update.taxableAmount = Math.round((finalAmount / (1 + finalGstRate / 100)) * 100) / 100;
        update.gstAmount = Math.round((finalAmount - update.taxableAmount) * 100) / 100;
      } else {
        update.taxableAmount = finalAmount;
        update.gstAmount = 0;
      }
    }

    const data = await Consultation.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!data) {
      return res.status(404).json({ success: false, error: "Consultation not found" });
    }

    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, error: "Unable to update consultation" });
  }
}

export async function deleteConsultation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid consultation id" });
    }

    await connectDB();
    const data = await Consultation.findByIdAndDelete(id);

    if (!data) {
      return res.status(404).json({ success: false, error: "Consultation not found" });
    }

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ success: false, error: "Unable to delete consultation" });
  }
}
