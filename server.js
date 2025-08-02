const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const { DynamoDBClient, PutItemCommand, ScanCommand, DeleteItemCommand, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const authMiddleware = require('./middleware/authMiddleware');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
// Environment variable validation
const requiredEnvVars = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'EMAIL_USER',
  'EMAIL_PASS',
  'RECEIVER_EMAIL'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5005;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Add this middleware before your routes
const sanitizeInput = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    // Recursively trim strings
    const sanitizeObject = (obj) => {
      for (let key in obj) {
        if (typeof obj[key] === 'string') {
          obj[key] = obj[key].trim();
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitizeObject(obj[key]);
        }
      }
    };
    sanitizeObject(req.body);
  }
  next();
};

// Use it before your routes
app.use(sanitizeInput);

// File upload configuration
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, JPG, PNG, and WebP images are allowed'));
    }
  }
});

// AWS Clients
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const dynamoClient = new DynamoDBClient({ 
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const TableName = process.env.DYNAMODB_TABLE_NAME || 'Cakes';

// Helper Functions
const sendErrorResponse = (res, statusCode, message, errorCode = null, details = null) => {
  const errorResponse = {
    success: false,
    message,
    error: errorCode,
    timestamp: new Date().toISOString()
  };
  
  if (details) {
    errorResponse.details = details;
  }
  
  return res.status(statusCode).json(errorResponse);
};

const sendSuccessResponse = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString()
  });
};

// Validation Functions
const validateProductData = (productData) => {
  const errors = [];
  
  if (!productData.title || !productData.title.trim()) {
    errors.push('Product title is required');
  }
  
  if (productData.title && productData.title.trim().length > 100) {
    errors.push('Title cannot exceed 100 characters');
  }
  
  // if (!productData.customizable) {
  //   if (!productData.availableWeights || productData.availableWeights.length === 0) {
  //     errors.push('At least one weight/price combination is required for non-customizable products');
  //   }
  // } else {
  //   if (!productData.price_range || !productData.price_range.trim()) {
  //     errors.push('Price range is required for customizable products');
  //   }
  //   if (!productData.weights_range || !productData.weights_range.trim()) {
  //     errors.push('Weight range is required for customizable products');
  //   }
  // }
  
  return errors;
};

// Check if title exists in DynamoDB
const checkTitleExists = async (title, excludeId = null) => {
  try {
    const params = {
      TableName,
      FilterExpression: 'title = :title',
      ExpressionAttributeValues: marshall({
        ':title': title.trim().toLowerCase()
      })
    };

    const result = await dynamoClient.send(new ScanCommand(params));
    const items = result.Items.map(item => unmarshall(item));
    
    if (excludeId) {
      return items.some(item => item.id !== excludeId);
    }
    
    return items.length > 0;
  } catch (error) {
    console.error('Error checking title existence:', error);
    throw new Error('Database error while checking title uniqueness');
  }
};

// More efficient way to check if product exists by ID
const getProductById = async (productId) => {
  try {
    const params = {
      TableName,
      Key: marshall({ id: productId })
    };
    
    const result = await dynamoClient.send(new GetItemCommand(params));
    return result.Item ? unmarshall(result.Item) : null;
  } catch (error) {
    console.error('Error getting product by ID:', error);
    throw new Error('Database error while fetching product');
  }
};

// Routes with Error Handling

// Image Upload Route
app.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return sendErrorResponse(res, 400, 'File size too large. Maximum size is 5MB', 'FILE_TOO_LARGE');
        }
        return sendErrorResponse(res, 400, err.message, 'UPLOAD_ERROR');
      }
      return sendErrorResponse(res, 400, err.message, 'INVALID_FILE_TYPE');
    }

    const file = req.file;
    if (!file) {
      return sendErrorResponse(res, 400, 'No file uploaded', 'NO_FILE');
    }

    const timestamp = Date.now();
    const sanitizedFileName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `product-cakes-image/${timestamp}_${sanitizedFileName}`;

    try {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME || 'product-cakes-image',
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'max-age=31536000', // 1 year cache
      }));

      const url = `https://${process.env.S3_BUCKET_NAME || 'product-cakes-image'}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
      
      sendSuccessResponse(res, { url }, 'Image uploaded successfully', 201);
    } catch (error) {
      console.error('S3 Upload Error:', error);
      sendErrorResponse(res, 500, 'Failed to upload image to cloud storage', 'S3_UPLOAD_ERROR');
    }
  });
});

// Cake Request Route
app.post('/api/send-cake-request', (req, res) => {
  upload.array('images', 10)(req, res, async (uploadErr) => {
    if (uploadErr) {
      if (uploadErr instanceof multer.MulterError) {
        if (uploadErr.code === 'LIMIT_FILE_SIZE') {
          return sendErrorResponse(res, 400, 'One or more files are too large. Maximum size is 5MB per file', 'FILES_TOO_LARGE');
        }
        return sendErrorResponse(res, 400, uploadErr.message, 'UPLOAD_ERROR');
      }
      return sendErrorResponse(res, 400, uploadErr.message, 'INVALID_FILE_TYPE');
    }

    try {
      const data = req.body;
      
      // Validate required fields
      const requiredFields = ['name', 'email', 'mobile', 'location', 'pincode', 'event', 'eventDate'];
      const missingFields = requiredFields.filter(field => !data[field] || !data[field].trim());
      
      if (missingFields.length > 0) {
        return sendErrorResponse(res, 400, `Missing required fields: ${missingFields.join(', ')}`, 'MISSING_FIELDS', { missingFields });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email)) {
        return sendErrorResponse(res, 400, 'Invalid email format', 'INVALID_EMAIL');
      }

      // Validate Indian mobile number (6-9 starting digits, 10 digits total)
      const mobileRegex = /^[6-9]\d{9}$/;
      if (!mobileRegex.test(data.mobile)) {
        return sendErrorResponse(res, 400, 'Invalid Indian mobile number format', 'INVALID_MOBILE');
      }

      const finalEvent = data.event === 'Other' ? data.customEvent : data.event;

      // Parse image descriptions
      let imageDescriptions = [];
      try {
        imageDescriptions = data.imageDescriptions ? JSON.parse(data.imageDescriptions) : [];
      } catch (parseError) {
        console.warn('Failed to parse image descriptions:', parseError);
        imageDescriptions = [];
      }

      // Create image attachments with descriptions
      const attachments = req.files ? req.files.map((file, index) => ({
        filename: file.originalname,
        content: file.buffer,
        contentType: file.mimetype,
      })) : [];

      // Build image descriptions section for email
      let imageDescriptionsHtml = '';
      if (req.files && req.files.length > 0) {
        imageDescriptionsHtml = `
          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #333; margin-top: 0;">🎨 Inspiration Images & Descriptions</h3>
            <p style="margin-bottom: 15px;"><strong>Number of images:</strong> ${req.files.length}</p>
            ${req.files.map((file, index) => `
              <div style="margin-bottom: 15px; padding: 10px; background: white; border-radius: 5px; border-left: 4px solid #667eea;">
                <p style="margin: 0 0 5px 0;"><strong>📷 Image ${index + 1}:</strong> ${file.originalname}</p>
                ${imageDescriptions[index] ? `
                  <p style="margin: 5px 0 0 0; color: #555; font-style: italic;">
                    <strong>Customer's note:</strong> "${imageDescriptions[index]}"
                  </p>
                ` : `
                  <p style="margin: 5px 0 0 0; color: #888; font-style: italic;">
                    No specific description provided for this image.
                  </p>
                `}
              </div>
            `).join('')}
          </div>
        `;
      }

      // Build final vision section
      let finalVisionHtml = '';
      if (data.finalDescription && data.finalDescription.trim()) {
        finalVisionHtml = `
          <div style="background: #e8f4fd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4a90e2;">
            <h3 style="color: #333; margin-top: 0;">✨ Customer's Final Vision</h3>
            <p style="margin: 0; color: #444; line-height: 1.6; font-size: 16px;">
              "${data.finalDescription}"
            </p>
          </div>
        `;
      }

      const adminEmailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; line-height: 1.6;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">🎂 Custom Cake Design Request</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">New request with ${req.files ? req.files.length : 0} inspiration image(s)</p>
          </div>
          
          <div style="background: white; padding: 20px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #333; margin-top: 0;">👤 Customer Details</h3>
              <p><strong>Name:</strong> ${data.name}</p>
              <p><strong>Email:</strong> ${data.email}</p>
              <p><strong>Mobile:</strong> +91 ${data.mobile}</p>
              <p><strong>Location:</strong> ${data.location}</p>
              <p><strong>Pincode:</strong> ${data.pincode}</p>
            </div>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #333; margin-top: 0;">🎉 Event & Cake Requirements</h3>
              <p><strong>Event:</strong> ${finalEvent}</p>
              <p><strong>Event Date:</strong> ${data.eventDate}</p>
              <p><strong>Theme/Style:</strong> ${data.theme || 'Not specified'}</p>
              <p><strong>Budget Range:</strong> ${data.budget || 'Not specified'}</p>
              <p><strong>Preference:</strong> ${data.eggless || 'Not specified'}</p>
            </div>

            ${imageDescriptionsHtml}
            
            ${finalVisionHtml}
            
            <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
              <p style="color: #666; font-size: 14px; margin: 0;">
                Request received on: ${new Date().toLocaleString('en-IN', { 
                  timeZone: 'Asia/Kolkata',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })} IST
              </p>
            </div>
          </div>
        </div>
      `;

      // Configure nodemailer
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      // Verify transporter configuration
      try {
        await transporter.verify();
      } catch (verifyError) {
        console.error('Email configuration error:', verifyError);
        return sendErrorResponse(res, 500, 'Email service configuration error', 'EMAIL_CONFIG_ERROR');
      }

      // Send email to admin
      try {
        await transporter.sendMail({
          from: `"Vani Bakers - Custom Orders" <${process.env.EMAIL_USER}>`,
          to: process.env.RECEIVER_EMAIL,
          subject: `🎂 Custom Cake Request - ${data.name} (${finalEvent} on ${data.eventDate})`,
          html: adminEmailBody,
          attachments,
        });
      } catch (emailError) {
        console.error('Admin email error:', emailError);
        return sendErrorResponse(res, 500, 'Failed to send notification to bakery', 'ADMIN_EMAIL_ERROR');
      }

      // Enhanced customer confirmation email
      const customerEmailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 24px;">🎉 Thank You, ${data.name}!</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">Your custom cake request has been received</p>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
            <p style="font-size: 16px; color: #333;">
              We've received your custom cake design request for <strong>${finalEvent}</strong> on <strong>${data.eventDate}</strong>.
            </p>
            
            <div style="background: #e8f4fd; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #333; margin-top: 0;">📋 Your Request Summary</h3>
              <ul style="margin: 0; padding-left: 20px;">
                <li><strong>Event:</strong> ${finalEvent}</li>
                <li><strong>Date:</strong> ${data.eventDate}</li>
                <li><strong>Budget:</strong> ${data.budget || 'To be discussed'}</li>
                <li><strong>Images Shared:</strong> ${req.files ? req.files.length : 0} inspiration image(s)</li>
                ${data.theme ? `<li><strong>Theme:</strong> ${data.theme}</li>` : ''}
              </ul>
            </div>
            
            <div style="background: #d4edda; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745;">
              <h3 style="color: #155724; margin-top: 0;">✨ What Happens Next?</h3>
              <ol style="margin: 0; padding-left: 20px; color: #155724;">
                <li>Our cake specialist will review your inspiration images and requirements</li>
                <li>We'll call you within <strong>24 hours</strong> to discuss design details</li>
                <li>You'll receive a custom quote based on your specifications</li>
                <li>Once approved, we'll start creating your dream cake!</li>
              </ol>
            </div>
            
            <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <p style="margin: 0; color: #856404;">
                <strong>Need to reach us urgently?</strong><br>
                📞 Call us at <strong>${process.env.BAKERY_PHONE || '+91 9442256262'}</strong><br>
                📧 Email: ${process.env.RECEIVER_EMAIL}
              </p>
            </div>
            
            <div style="text-align: center; margin-top: 30px;">
              <p style="color: #4a90e2; font-size: 18px; margin: 0;">
                <strong>– Team Vani Bakers 🎂</strong>
              </p>
              <p style="color: #666; font-size: 14px; margin: 5px 0 0 0;">
                Creating sweet memories, one cake at a time
              </p>
            </div>
          </div>
        </div>
      `;

      // Send confirmation email to customer
      try {
        await transporter.sendMail({
          from: `"Vani Bakers" <${process.env.EMAIL_USER}>`,
          to: data.email,
          subject: `🎂 Custom Cake Request Received - ${finalEvent}`,
          html: customerEmailBody,
        });
      } catch (customerEmailError) {
        console.error('Customer email error:', customerEmailError);
        // Don't fail the request if customer email fails
      }

      sendSuccessResponse(res, 
        { 
          requestId: `CUSTOM_${Date.now()}`,
          message: 'Your custom cake request has been submitted successfully',
          imagesCount: req.files ? req.files.length : 0,
          hasVisionDescription: !!(data.finalDescription && data.finalDescription.trim())
        }, 
        'Custom cake request submitted successfully'
      );

    } catch (error) {
      console.error('Cake request error:', error);
      sendErrorResponse(res, 500, 'Failed to process cake request', 'REQUEST_PROCESSING_ERROR');
    }
  });
});


// Check title availability
// app.get('/api/products/check-title', async (req, res) => {
//   try {
//     const { title, excludeId } = req.query;
    
//     if (!title) {
//       return sendSuccessResponse(res, { 
//         exists: false, 
//         available: true,
//         message: 'No title provided' 
//       });
//     }

//     const exists = await checkTitleExists(title, excludeId);
    
//     sendSuccessResponse(res, {
//       exists,
//       available: !exists,
//       message: exists ? 'Title already exists' : 'Title available'
//     });
//   } catch (error) {
//     console.error('Title check error:', error);
//     sendErrorResponse(res, 500, 'Failed to check title availability', 'DATABASE_ERROR');
//   }
// });

// Apply auth middleware to product routes
app.use('/api/products', authMiddleware);

// GET /api/custom-cakes/images - Fetch all images from custom-cakes bucket
app.get('/api/custom-cakes/images', async (req, res) => {
  try {
    const bucketName = process.env.CUSTOM_CAKES_BUCKET || 'custom-cakes';
    const region = process.env.AWS_REGION || 'ap-south-1';
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 50
    });

    const result = await s3.send(command);
    const imageObjects = (result.Contents || [])
      .filter(object => {
        const key = object.Key.toLowerCase();
        return key.endsWith('.jpg') || 
               key.endsWith('.jpeg') || 
               key.endsWith('.png') || 
               key.endsWith('.webp') ||
               key.endsWith('.gif');
      })
      .map(object => ({
        img: `https://${bucketName}.s3.${region}.amazonaws.com/${object.Key}`,
        key: object.Key,
        lastModified: object.LastModified,
        size: object.Size
      }));
    sendSuccessResponse(res, {
      images: imageObjects,
      count: imageObjects.length
    }, 'Custom cake images fetched successfully');
  } catch (error) {
    console.error('Error fetching custom cake images:', error);
    sendErrorResponse(res, 'Error fetching custom cake images', 500);
  }
});

// Product Routes

// GET /api/products - List all products
app.get('/api/products', async (req, res) => {
  try {
    const result = await dynamoClient.send(new ScanCommand({ TableName }));
    const products = result.Items.map(item => unmarshall(item));
    
    // Sort by creation date (newest first)
    const sortedProducts = products.sort((a, b) => {
      const dateA = new Date(a.createdAt || 0);
      const dateB = new Date(b.createdAt || 0);
      return dateB - dateA;
    });

    sendSuccessResponse(res, sortedProducts, `Retrieved ${sortedProducts.length} products`);
  } catch (error) {
    console.error('Error fetching products:', error);
    sendErrorResponse(res, 500, 'Failed to fetch products', 'DATABASE_ERROR');
  }
});

// POST /api/products - Create a new product
app.post('/api/products', async (req, res) => {
  try {
    const productData = req.body;
    
    // Validate product data
    const validationErrors = validateProductData(productData);
    if (validationErrors.length > 0) {
      return sendErrorResponse(res, 400, 'Validation failed', 'VALIDATION_ERROR', { errors: validationErrors });
    }

    // Check if title already exists
    const titleExists = await checkTitleExists(productData.title);
    if (titleExists) {
      return sendErrorResponse(res, 400, `A product with the title "${productData.title}" already exists`, 'DUPLICATE_TITLE', { field: 'title' });
    }

    // Create new product with metadata
    const timestamp = new Date().toISOString();
    const newProduct = {
      ...productData,
      id: `cake_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: productData.title.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      isActive: true
    };

    // Clean up data based on customizable flag
    if (newProduct.customizable) {
      delete newProduct.availableWeights;
      delete newProduct.defaultWeight;
    } else {
      delete newProduct.price_range;
      delete newProduct.weights_range;
    }

    await dynamoClient.send(new PutItemCommand({
      TableName,
      Item: marshall(newProduct),
      ConditionExpression: 'attribute_not_exists(id)' // Prevent duplicates
    }));

    sendSuccessResponse(res, newProduct, 'Product created successfully', 201);
  } catch (error) {
    console.error('Error creating product:', error);
    
    if (error.name === 'ConditionalCheckFailedException') {
      return sendErrorResponse(res, 409, 'Product with this ID already exists', 'DUPLICATE_ID');
    }
    
    sendErrorResponse(res, 500, 'Failed to create product', 'DATABASE_ERROR');
  }
});

// Use this in your PUT and DELETE routes instead of ScanCommand
app.put('/api/products/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const productData = req.body;

    if (!productId) {
      return sendErrorResponse(res, 400, 'Product ID is required', 'MISSING_ID');
    }

    // Validate product data
    const validationErrors = validateProductData(productData);
    if (validationErrors.length > 0) {
      return sendErrorResponse(res, 400, 'Validation failed', 'VALIDATION_ERROR', { errors: validationErrors });
    }

    // Check if title already exists (excluding current product)
    const titleExists = await checkTitleExists(productData.title, productId);
    if (titleExists) {
      return sendErrorResponse(res, 400, `A product with the title "${productData.title}" already exists`, 'DUPLICATE_TITLE', { field: 'title' });
    }

    // Get existing product more efficiently
    const existingProduct = await getProductById(productId);
    
    if (!existingProduct) {
      return sendErrorResponse(res, 404, 'Product not found', 'PRODUCT_NOT_FOUND');
    }
    
    // Update product with preserved metadata
    const updatedProduct = {
      ...productData,
      id: productId,
      title: productData.title.trim(),
      createdAt: existingProduct.createdAt,
      updatedAt: new Date().toISOString(),
      isActive: true
    };

    // Clean up data based on customizable flag
    if (updatedProduct.customizable) {
      delete updatedProduct.availableWeights;
      delete updatedProduct.defaultWeight;
    } else {
      delete updatedProduct.price_range;
      delete updatedProduct.weights_range;
    }

    await dynamoClient.send(new PutItemCommand({
      TableName,
      Item: marshall(updatedProduct),
    }));

    sendSuccessResponse(res, updatedProduct, 'Product updated successfully');
  } catch (error) {
    console.error('Error updating product:', error);
    sendErrorResponse(res, 500, 'Failed to update product', 'DATABASE_ERROR');
  }
});

// Update DELETE route as well
app.delete('/api/products/:id', async (req, res) => {
  try {
    const productId = req.params.id;

    if (!productId) {
      return sendErrorResponse(res, 400, 'Product ID is required', 'MISSING_ID');
    }

    // Check if product exists more efficiently
    const existingProduct = await getProductById(productId);
    
    if (!existingProduct) {
      return sendErrorResponse(res, 404, 'Product not found', 'PRODUCT_NOT_FOUND');
    }

    await dynamoClient.send(new DeleteItemCommand({
      TableName,
      Key: marshall({ id: productId }),
    }));

    sendSuccessResponse(res, { id: productId }, 'Product deleted successfully');
  } catch (error) {
    console.error('Error deleting product:', error);
    sendErrorResponse(res, 500, 'Failed to delete product', 'DATABASE_ERROR');
  }
});

// Quick Suggestions Routes

// Define a new table name for quick suggestions
const QuickSuggestionsTable = 'quickSuggestion';
const SUGGESTIONS_ID = 'all_suggestions';

// GET /api/quick-suggestions - Get all quick suggestions from single JSON
app.get('/api/quick-suggestions', async (req, res) => {
  try {
    const params = {
      TableName: QuickSuggestionsTable,
      Key: marshall({ id: SUGGESTIONS_ID })
    };
    
    const result = await dynamoClient.send(new GetItemCommand(params));
    
    if (result.Item) {
      const record = unmarshall(result.Item);
      sendSuccessResponse(res, record.suggestions || {}, 'Retrieved quick suggestions successfully');
    } else {
      // Return empty suggestions if no record exists
      sendSuccessResponse(res, {}, 'No quick suggestions found');
    }
  } catch (error) {
    console.error('Error fetching quick suggestions:', error);
    sendErrorResponse(res, 500, 'Failed to fetch quick suggestions', 'DATABASE_ERROR');
  }
});

// POST /api/quick-suggestions - Save all quick suggestions in single JSON
app.post('/api/quick-suggestions', authMiddleware, async (req, res) => {
  try {
    const { suggestions } = req.body; // Expected: { flavor: ["chocolate", "vanilla"], event: ["birthday"] }
    
    // Validate input
    if (!suggestions || typeof suggestions !== 'object') {
      return sendErrorResponse(res, 400, 'Suggestions object is required', 'VALIDATION_ERROR');
    }

    const timestamp = new Date().toISOString();
    
    // Clean and validate suggestions
    const cleanedSuggestions = {};
    Object.entries(suggestions).forEach(([field, values]) => {
      if (Array.isArray(values)) {
        const cleanValues = values
          .map(value => String(value).trim())
          .filter(value => value.length > 0)
          .filter((value, index, array) => 
            // Remove duplicates (case-insensitive)
            array.findIndex(v => v.toLowerCase() === value.toLowerCase()) === index
          );
          
        if (cleanValues.length > 0) {
          cleanedSuggestions[field] = cleanValues;
        }
      }
    });

    // Create/update the single record with all suggestions
    const suggestionRecord = {
      id: SUGGESTIONS_ID,
      suggestions: cleanedSuggestions,
      updatedAt: timestamp,
      createdAt: timestamp
    };

    await dynamoClient.send(new PutItemCommand({
      TableName: QuickSuggestionsTable,
      Item: marshall(suggestionRecord)
    }));
    
    sendSuccessResponse(res, cleanedSuggestions, 'Quick suggestions saved successfully', 200);
  } catch (error) {
    console.error('Error saving quick suggestions:', error);
    sendErrorResponse(res, 500, 'Failed to save quick suggestions', 'DATABASE_ERROR');
  }
});

// PUT /api/quick-suggestions - Alternative endpoint for updates
app.put('/api/quick-suggestions', authMiddleware, async (req, res) => {
  try {
    const { suggestions } = req.body;
    
    if (!suggestions || typeof suggestions !== 'object') {
      return sendErrorResponse(res, 400, 'Suggestions object is required', 'VALIDATION_ERROR');
    }

    // Get existing record first
    const getParams = {
      TableName: QuickSuggestionsTable,
      Key: marshall({ id: SUGGESTIONS_ID })
    };
    
    const existingResult = await dynamoClient.send(new GetItemCommand(getParams));
    const existingRecord = existingResult.Item ? unmarshall(existingResult.Item) : {};

    const timestamp = new Date().toISOString();
    
    // Clean new suggestions
    const cleanedSuggestions = {};
    Object.entries(suggestions).forEach(([field, values]) => {
      if (Array.isArray(values)) {
        const cleanValues = values
          .map(value => String(value).trim())
          .filter(value => value.length > 0)
          .filter((value, index, array) => 
            array.findIndex(v => v.toLowerCase() === value.toLowerCase()) === index
          );
          
        if (cleanValues.length > 0) {
          cleanedSuggestions[field] = cleanValues;
        }
      }
    });

    const updatedRecord = {
      id: SUGGESTIONS_ID,
      suggestions: cleanedSuggestions,
      updatedAt: timestamp,
      createdAt: existingRecord.createdAt || timestamp
    };

    await dynamoClient.send(new PutItemCommand({
      TableName: QuickSuggestionsTable,
      Item: marshall(updatedRecord)
    }));
    
    sendSuccessResponse(res, cleanedSuggestions, 'Quick suggestions updated successfully');
  } catch (error) {
    console.error('Error updating quick suggestions:', error);
    sendErrorResponse(res, 500, 'Failed to update quick suggestions', 'DATABASE_ERROR');
  }
});

// DELETE /api/quick-suggestions - Clear all suggestions
app.delete('/api/quick-suggestions', authMiddleware, async (req, res) => {
  try {
    await dynamoClient.send(new DeleteItemCommand({
      TableName: QuickSuggestionsTable,
      Key: marshall({ id: SUGGESTIONS_ID })
    }));

    sendSuccessResponse(res, {}, 'All quick suggestions cleared successfully');
  } catch (error) {
    console.error('Error clearing quick suggestions:', error);
    sendErrorResponse(res, 500, 'Failed to clear quick suggestions', 'DATABASE_ERROR');
  }
});

// Global error handler (keep this - it's correct)
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  sendErrorResponse(res, 500, 'Internal server error', 'INTERNAL_ERROR');
});

// Handle 404 - Use standard middleware instead of '*' pattern
app.use((req, res) => {
  sendErrorResponse(res, 404, `Route ${req.originalUrl} not found`, 'ROUTE_NOT_FOUND');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

