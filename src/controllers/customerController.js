import mongoose from "mongoose";
import { connectDB } from "../lib/dbConnect.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import Consultation from "../models/Consultation.js";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhone(p) {
  if (!p) return "";
  return String(p).replace(/\D/g, "").slice(-10);
}

export async function getAdminCustomers(req, res) {
  try {
    await connectDB();
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const q = req.query.q?.trim()?.toLowerCase();

    // 1. Fetch real users
    const users = await User.find({})
      .select("-passwordHash -otp -otpExpiresAt -otpAttempts")
      .lean();

    // 2. Fetch all real orders
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .lean();

    // 3. Fetch all real consultations
    const consultations = await Consultation.find({})
      .sort({ createdAt: -1 })
      .lean();

    // Grouping map by normalized phone or email or id
    const customerMap = new Map();

    function getOrCreate(key, defaults = {}) {
      if (!customerMap.has(key)) {
        customerMap.set(key, {
          _id: defaults._id || key,
          id: `CUS-${String(defaults._id || key).slice(-6).toUpperCase()}`,
          name: defaults.name || "Customer",
          email: defaults.email || "—",
          phone: defaults.phone || "—",
          city: defaults.city || "—",
          state: defaults.state || "Rajasthan",
          address: defaults.address || "—",
          joined: defaults.createdAt || new Date(),
          isActive: defaults.isActive !== false,
          notes: defaults.notes || "",
          ordersCount: 0,
          totalSpent: 0,
          recentOrders: [],
          recentConsultations: [],
        });
      }
      return customerMap.get(key);
    }

    // Process registered users first
    for (const u of users) {
      const phone = normalizePhone(u.phone);
      const email = u.email ? u.email.toLowerCase().trim() : "";
      const key = phone || email || String(u._id);

      const addr = u.addresses?.[0] || {};
      const fullAddress = [addr.line1, addr.city, addr.state, addr.postalCode].filter(Boolean).join(", ") || u.address || "";

      getOrCreate(key, {
        _id: u._id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        city: addr.city || u.city || "",
        state: addr.state || u.state || "Rajasthan",
        address: fullAddress,
        createdAt: u.createdAt,
        isActive: u.isActive,
        notes: u.notes,
      });
    }

    // Process orders
    for (const o of orders) {
      const phone = normalizePhone(o.customerSnapshot?.phone || o.shippingAddress?.phone);
      const email = (o.customerSnapshot?.email || o.shippingAddress?.email || "").toLowerCase().trim();
      const userKey = phone || email || (o.customer ? String(o.customer) : String(o._id));

      const entry = getOrCreate(userKey, {
        _id: o.customer || o._id,
        name: o.customerSnapshot?.fullName || o.customerSnapshot?.name || o.shippingAddress?.name || "Customer",
        email: email,
        phone: phone,
        city: o.customerSnapshot?.city || o.shippingAddress?.city || "",
        state: o.customerSnapshot?.state || o.shippingAddress?.state || "Rajasthan",
        address: o.customerSnapshot?.address || o.shippingAddress?.address || "",
        createdAt: o.createdAt,
      });

      // Prefer real customer name over default
      const orderName = o.customerSnapshot?.fullName || o.customerSnapshot?.name;
      if (orderName && (!entry.name || entry.name === "Customer" || entry.name.toLowerCase().includes("admin"))) {
        entry.name = orderName;
      }
      if ((!entry.phone || entry.phone === "—") && phone) entry.phone = phone;
      if ((!entry.email || entry.email === "—") && email) entry.email = email;
      if ((!entry.city || entry.city === "—") && (o.customerSnapshot?.city || o.shippingAddress?.city)) {
        entry.city = o.customerSnapshot?.city || o.shippingAddress?.city;
      }
      if ((!entry.address || entry.address === "—") && (o.customerSnapshot?.address || o.shippingAddress?.address)) {
        entry.address = o.customerSnapshot?.address || o.shippingAddress?.address;
      }

      // Order stats
      entry.ordersCount += 1;
      const orderTotal = Number(o.total || 0);
      if (o.paymentStatus === "paid" || o.status === "delivered" || o.status === "confirmed") {
        entry.totalSpent += orderTotal;
      }

      entry.recentOrders.push({
        _id: o._id,
        orderNumber: o.orderNumber,
        date: o.createdAt,
        total: orderTotal,
        status: o.status,
        paymentStatus: o.paymentStatus,
        itemCount: o.items?.length || 1,
        itemsSummary: o.items?.map((it) => it.name).join(", ") || "Products",
      });
    }

    // Process consultations
    for (const c of consultations) {
      const phone = normalizePhone(c.phone || c.userPhone);
      const email = (c.email || "").toLowerCase().trim();
      const userKey = phone || email || String(c._id);

      const entry = getOrCreate(userKey, {
        _id: c._id,
        name: c.name || "Client",
        email: email,
        phone: phone,
        city: c.propertyAddress ? "Jaipur" : "",
        state: c.state || "Rajasthan",
        address: c.propertyAddress || c.residentialAddress || "",
        createdAt: c.createdAt,
      });

      if (!entry.name || entry.name === "Customer" || entry.name === "Client") {
        if (c.name) entry.name = c.name;
      }
      if ((!entry.phone || entry.phone === "—") && phone) entry.phone = phone;
      if ((!entry.email || entry.email === "—") && email) entry.email = email;

      const consultAmount = Number(c.amount || 0);
      if (c.paymentStatus === "paid") {
        entry.totalSpent += consultAmount;
      }

      entry.recentConsultations.push({
        _id: c._id,
        reference: c.reference || c.documentNo,
        date: c.scheduledDate || c.date || c.createdAt,
        amount: consultAmount,
        status: c.status,
        paymentStatus: c.paymentStatus,
        type: c.type || "Vastu Consultation",
        mode: c.mode,
      });
    }

    let customerList = Array.from(customerMap.values());

    // Apply search filter if provided
    if (q) {
      customerList = customerList.filter((c) =>
        [c.name, c.email, c.phone, c.city, c.state, c.id].some((val) =>
          String(val || "").toLowerCase().includes(q)
        )
      );
    }

    // Sort by most recent activity or joined date
    customerList.sort((a, b) => new Date(b.joined) - new Date(a.joined));

    const total = customerList.length;
    const paginated = customerList.slice((page - 1) * limit, page * limit);

    return res.json({
      success: true,
      data: paginated,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getAdminCustomers error:", err);
    return res.status(500).json({ success: false, error: "Unable to fetch customers" });
  }
}

export async function updateAdminCustomer(req, res) {
  try {
    const { id } = req.params;
    const { name, email, phone, city, state, address, status, notes } = req.body || {};

    await connectDB();
    const update = {};
    if (name !== undefined) update.name = name;
    if (email !== undefined) update.email = email;
    if (phone !== undefined) update.phone = phone;
    if (city !== undefined) update.city = city;
    if (state !== undefined) update.state = state;
    if (address !== undefined) update.address = address;
    if (status !== undefined) update.isActive = status === "Active";
    if (notes !== undefined) update.notes = notes;

    if (mongoose.isValidObjectId(id)) {
      const data = await User.findByIdAndUpdate(
        id,
        { $set: update },
        { new: true }
      ).select("-passwordHash -otp -otpExpiresAt -otpAttempts").lean();

      if (data) {
        return res.json({ success: true, data });
      }
    }

    return res.json({ success: true, message: "Customer updated" });
  } catch {
    return res.status(500).json({ success: false, error: "Unable to update customer" });
  }
}

export async function deleteAdminCustomer(req, res) {
  try {
    const { id } = req.params;
    await connectDB();
    if (mongoose.isValidObjectId(id)) {
      await User.findByIdAndDelete(id);
    }
    return res.json({ success: true, message: "Customer removed successfully" });
  } catch {
    return res.status(500).json({ success: false, error: "Unable to delete customer" });
  }
}
