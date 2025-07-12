const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 5005;
const multer = require('multer');
const path = require('path');
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());

app.post('/api/send-cake-request', upload.array('images'), async (req, res) => {
  const data = req.body;
  const finalEvent = data.event === 'Other' ? data.customEvent : data.event;

  const adminEmailBody = `
    <h2>🎂 Cake Request from ${data.name}</h2>
    <p><strong>Email:</strong> ${data.email}</p>
    <p><strong>Mobile:</strong> ${data.mobile}</p>
    <p><strong>Location:</strong> ${data.location}</p>
    <p><strong>Event:</strong> ${finalEvent}</p>
    <p><strong>Event Date:</strong> ${data.eventDate}</p>
    <p><strong>Theme:</strong> ${data.theme}</p>
    <p><strong>Budget:</strong> ${data.budget}</p>
    <p><strong>Egg/Eggless:</strong> ${data.eggless}</p>
  `;

  // Attach uploaded images
  const attachments = req.files.map((file) => ({
    filename: file.originalname,
    content: file.buffer,
    contentType: file.mimetype,
  }));

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // 1️⃣ Send to bakery (with attachments)
    await transporter.sendMail({
      from: `"Vani Bakers" <${process.env.EMAIL_USER}>`,
      to: process.env.RECEIVER_EMAIL,
      subject: 'New Cake Request from Website',
      html: adminEmailBody,
      attachments,
    });

    // 2️⃣ Send to user
    await transporter.sendMail({
      from: `"Vani Bakers" <${process.env.EMAIL_USER}>`,
      to: data.email,
      subject: '🎉 Thank You for Your Cake Request!',
      html: `
        <p>Hi ${data.name},</p>
        <p>Thank you for your request! Our team will call you soon.</p>
        <p>– Team Vani Bakers 🎂</p>
      `,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ success: false });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
