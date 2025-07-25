const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 5005;
const multer = require('multer');
const path = require('path');
const upload = multer({ storage: multer.memoryStorage() });
const { DynamoDBClient, PutItemCommand, ScanCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const authMiddleware = require('./middleware/authMiddleware');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
app.use(cors());
app.use(express.json());
app.use('/api/products', authMiddleware);

const s3 = new S3Client({
  region: 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

app.post('/api/upload', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).send('No file uploaded');
  }
  const key = `product-cakes-image/${Date.now()}_${file.originalname}`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket: 'product-cakes-image',
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));
    const url = `https://product-cakes-image.s3.ap-south-1.amazonaws.com/${key}`;
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to upload');
  }
});

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

const client = new DynamoDBClient({ region: 'ap-south-1' });
const TableName = 'Cakes';

// --- API ROUTES ---

// GET /api/products - List all products
app.get('/api/products', async (req, res) => {
  const { Items } = await client.send(new ScanCommand({ TableName }));
  res.json(Items.map(item => unmarshall(item)));
});

// POST /api/products - Create a new product (with auto-generated ID)
app.post('/api/products', async (req, res) => {
  const productData = req.body;
  
  // Create the full product object with a new ID
  const newProduct = {
    ...productData,
    id: `cake_${Date.now()}`, // Auto-generate ID here
  };

  try {
    await client.send(new PutItemCommand({
      TableName,
      Item: marshall(newProduct),
    }));
    // Return the newly created product, including its new ID
    res.status(201).json({ message: 'Product saved'});
  } catch (err) {
    console.error('DynamoDB Error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT /api/products/:id - Update an existing product
app.put('/api/products/:id', async (req, res) => {
  const productData = { ...req.body, id: req.params.id };
  await client.send(new PutItemCommand({
    TableName,
    Item: marshall(productData),
  }));
  res.json({ message: 'Product updated successfully' });
});


// DELETE /api/products/:id - Delete a product
app.delete('/api/products/:id', async (req, res) => {
    // ... (no changes needed here, it's now protected)
    await client.send(new DeleteItemCommand({
        TableName,
        Key: marshall({ id: req.params.id }),
    }));
    res.json({ message: 'Product deleted' });
});



app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
