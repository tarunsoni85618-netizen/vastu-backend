import mongoose from "mongoose";
import { connectDB } from "../lib/dbConnect.js";
import Donation from "../models/Donation.js";
import { createRazorpayOrder, verifyRazorpaySignature } from "../lib/razorpay.js";
import { getPaymentSuccessUrl, getPaymentFailureUrl } from "../lib/redirects.js";

export async function initiateDonation(req, res) {
  try {
    const { donorName, donorPhone, donorEmail, amount, pan, message } = req.body || {};

    if (!donorName?.trim() || !donorPhone?.trim()) {
      return res.status(400).json({
        success: false,
        error: "Donor name and phone number are required",
      });
    }

    const numAmount = Number(amount) || 0;
    if (numAmount < 10) {
      return res.status(400).json({
        success: false,
        error: "Minimum donation amount is ₹10",
      });
    }
    const cleanedPhone = donorPhone.replace(/\D/g, "").slice(-10);
    if (cleanedPhone.length < 10) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid 10-digit mobile number",
      });
    }

    await connectDB();
    const donationId = `BSV-NGO-${Date.now().toString().slice(-6)}`;
    const txnid = `TXN_DON_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const rzpOrder = await createRazorpayOrder({
      amount: numAmount,
      receipt: donationId,
      notes: {
        donationId,
        type: "donation",
        donorName: donorName.trim().slice(0, 40),
      },
    });

    const donation = await Donation.create({
      donationId,
      donorName: donorName.trim(),
      donorPhone: cleanedPhone,
      donorEmail: (donorEmail || "").trim(),
      amount: numAmount,
      purpose: "Choti Khushi NGO - Feeding Work for Birds",
      pan: (pan || "").trim(),
      message: (message || "").trim(),
      txnid,
      paymentStatus: "pending",
      paymentProvider: "online",
      paymentReference: rzpOrder?.orderId || txnid,
    });

    return res.json({
      success: true,
      provider: "razorpay",
      keyId: rzpOrder.keyId,
      orderId: rzpOrder.orderId,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      donationId,
      txnid,
      customer: {
        name: donorName.trim(),
        email: (donorEmail || "donor@example.com").trim(),
        phone: cleanedPhone,
      },
    });
  } catch (error) {
    console.error("initiateDonation error:", error);
    return res.status(500).json({ success: false, error: "Unable to initiate donation" });
  }
}

/**
 * Verify Razorpay payment for Donation
 */
export async function verifyDonationPayment(req, res) {
  try {
    await connectDB();
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      donationId,
      txnid,
    } = req.body || {};

    const donation = await Donation.findOne({
      $or: [
        ...(donationId ? [{ donationId }] : []),
        ...(txnid ? [{ txnid }] : []),
        ...(razorpay_order_id ? [{ paymentReference: razorpay_order_id }] : []),
      ],
    });

    if (!donation) {
      return res.status(404).json({ success: false, error: "Donation record not found" });
    }

    if (donation.paymentStatus === "paid") {
      const redirectUrl = getPaymentSuccessUrl({
        type: "donation",
        status: "success",
        donationId: donation.donationId,
        amount: donation.amount,
        txnid: donation.paymentReference,
      });
      return res.json({
        success: true,
        message: "Donation already verified",
        redirectUrl,
        donation,
      });
    }

    const isValid = verifyRazorpaySignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      donation.paymentStatus = "failed";
      await donation.save();
      const redirectUrl = getPaymentFailureUrl({
        type: "donation",
        status: "failed",
        donationId: donation.donationId,
        error: "Payment verification failed",
      });
      return res.status(400).json({
        success: false,
        error: "Payment verification failed",
        redirectUrl,
      });
    }

    donation.paymentStatus = "paid";
    donation.paymentProvider = "online";
    donation.paymentReference = razorpay_payment_id || razorpay_order_id || txnid;
    await donation.save();

    const redirectUrl = getPaymentSuccessUrl({
      type: "donation",
      status: "success",
      donationId: donation.donationId,
      amount: donation.amount,
      txnid: donation.paymentReference,
    });

    return res.json({
      success: true,
      message: "Donation payment verified successfully!",
      redirectUrl,
      donation,
    });
  } catch (err) {
    console.error("verifyDonationPayment error:", err);
    return res.status(500).json({ success: false, error: "Verification server error" });
  }
}

export async function getMyDonations(req, res) {
  try {
    await connectDB();
    const phoneParam = req.query?.phone ? String(req.query.phone).replace(/\D/g, "") : "";
    const userPhone = req.user?.phone ? String(req.user.phone).replace(/\D/g, "").slice(-10) : (phoneParam.length >= 10 ? phoneParam.slice(-10) : "");
    const userEmail = req.user?.email ? String(req.user.email).trim().toLowerCase() : (req.query?.email ? String(req.query.email).trim().toLowerCase() : "");
    const userId = req.user?.id || req.user?._id;

    if (!userId && !userPhone && !userEmail) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const conditions = [];
    if (userId && mongoose.isValidObjectId(userId)) {
      conditions.push({ donor: new mongoose.Types.ObjectId(userId) });
    }
    if (userPhone && userPhone.length >= 10) {
      conditions.push({ donorPhone: { $regex: new RegExp(userPhone + "$") } });
    }
    if (userEmail) {
      conditions.push({ donorEmail: userEmail });
    }

    if (conditions.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const data = await Donation.find({ $or: conditions })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data });
  } catch (error) {
    console.error("getMyDonations error:", error);
    return res.status(500).json({ success: false, error: "Unable to fetch donations" });
  }
}

export async function getAdminDonations(req, res) {
  try {
    await connectDB();
    const data = await Donation.find({}).sort({ createdAt: -1 }).lean();

    const paidDonations = data.filter((d) => d.paymentStatus === "paid");
    const totalRaised = paidDonations.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

    return res.json({
      success: true,
      data,
      stats: {
        totalDonations: data.length,
        paidCount: paidDonations.length,
        totalRaised,
      },
    });
  } catch (error) {
    console.error("getAdminDonations error:", error);
    return res.status(500).json({ success: false, error: "Unable to fetch admin donations" });
  }
}
