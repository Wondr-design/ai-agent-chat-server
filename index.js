import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
import "./instrument.js";

// All other imports below

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage (in production, use a proper database)
let conversations = [];
let configuration = {
  instagram: {
    pageId: process.env.INSTAGRAM_PAGE_ID || "",
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "",
    verifyToken: process.env.WEBHOOK_VERIFY_TOKEN || "myverifytoken",
  },
  gpt: {
    provider: process.env.LLM_PROVIDER || "openai", // 'openai' or 'gemini'
    apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || "",
    endpoint:
      process.env.GPT_ENDPOINT || "https://api.openai.com/v1/chat/completions",
    model: process.env.LLM_MODEL || "gpt-3.5-turbo",
    prompt: `You are a professional appointment setter for a business. Your goal is to qualify leads and book appointments through natural conversation. Keep responses friendly, helpful, and human-like.

Key objectives:
1. Understand the user's needs
2. Qualify them as a potential client
3. Offer to schedule a consultation when appropriate
4. Provide the booking link when they're interested

Always maintain a conversational, helpful tone and avoid sounding robotic.`,
  },
  booking: {
    calendlyUrl: process.env.CALENDLY_URL || "",
    provider: "calendly",
  },
  responses: {
    welcomeMessage:
      "Hey! Thanks for reaching out. I'd love to help you with your needs. What brings you here today?",
    qualificationPrompt:
      "Tell me a bit more about what you're looking for so I can better assist you.",
    bookingOffer:
      "It sounds like we might be a great fit! Would you like to schedule a quick consultation to discuss this further?",
    bookingLink:
      "Perfect! Here's my calendar link to grab a time that works for you: {BOOKING_URL}",
  },
};

// Helper functions
const verifyWebhookSignature = (payload, signature) => {
  const expectedSignature = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET || "default_secret")
    .update(payload)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expectedSignature}`)
  );
};

const sendMessageToOpenAI = async (message, conversationHistory = []) => {
  const messages = [
    { role: "system", content: configuration.gpt.prompt },
    ...conversationHistory.map((msg) => ({
      role: msg.sender === "user" ? "user" : "assistant",
      content: msg.text,
    })),
    { role: "user", content: message },
  ];

  const response = await axios.post(
    configuration.gpt.endpoint,
    {
      model: configuration.gpt.model,
      messages: messages,
      max_tokens: 150,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${configuration.gpt.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  return response.data.choices[0].message.content.trim();
};

const sendMessageToLLM = async (message, conversationHistory = []) => {
  return await sendMessageToOpenAI(message, conversationHistory);
};

const sendInstagramMessage = async (recipientId, message) => {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v23.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: message },
        messaging_type: "RESPONSE",
      },
      {
        headers: {
          Authorization: `Bearer ${configuration.instagram.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error(
      "Instagram API error response:",
      error.response?.data || error.message
    );
    console.error("Error sending Instagram message:", error);
    throw error;
  }
};

const addMessageToConversation = (userId, username, message, sender) => {
  let conversation = conversations.find((c) => c.userId === userId);

  if (!conversation) {
    conversation = {
      id: crypto.randomUUID(),
      userId,
      username: username || `user_${userId.slice(-6)}`,
      messages: [],
      status: "active",
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    conversations.push(conversation);
  }

  conversation.messages.push({
    id: crypto.randomUUID(),
    text: message,
    sender,
    timestamp: new Date(),
  });

  conversation.lastActivity = new Date();
  return conversation;
};

// Routes

// Webhook verification (GET request from Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === configuration.instagram.verifyToken) {
      console.log("Webhook verified successfully!");
      res.status(200).send(challenge);
    } else {
      console.log("Webhook verification failed");
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook for receiving Instagram messages (POST request from Meta)
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object === "instagram") {
      for (const entry of body.entry || []) {
        const webhookEvent = entry.messaging?.[0];

        if (webhookEvent?.message) {
          const senderId = webhookEvent.sender.id;
          const messageText = webhookEvent.message.text;

          if (messageText) {
            console.log(`Received message from ${senderId}: ${messageText}`);

            // Add user message to conversation
            const conversation = addMessageToConversation(
              senderId,
              null, // Username will be generated
              messageText,
              "user"
            );

            // Get LLM response
            const llmResponse = await sendMessageToLLM(
              messageText,
              conversation.messages.slice(0, -1)
            );

            // Replace booking URL placeholder
            const finalResponse = llmResponse.replace(
              "{BOOKING_URL}",
              configuration.booking.calendlyUrl
            );

            // Simulate typing delay
            setTimeout(async () => {
              try {
                // Send response via Instagram API
                await sendInstagramMessage(senderId, finalResponse);

                // Add bot response to conversation
                addMessageToConversation(senderId, null, finalResponse, "bot");

                console.log(`Sent response to ${senderId}: ${finalResponse}`);
              } catch (error) {
                console.error("Failed to send Instagram message:", error);
              }
            }, Math.random() * 3000 + 2000); // 2-5 second delay
          }
        }
      }
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(500).send("Internal server error");
  }
});

// API Routes
app.get("/api/status", (req, res) => {
  const status = {
    webhook: "connected", // Assume connected if server is running
    instagram: configuration.instagram.accessToken
      ? "connected"
      : "disconnected",
    gpt: configuration.gpt.apiKey ? "connected" : "disconnected",
    booking: configuration.booking.calendlyUrl ? "connected" : "disconnected",
  };
  res.json(status);
});

app.get("/api/conversations", (req, res) => {
  // Sort conversations by last activity
  const sortedConversations = conversations.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );
  res.json(sortedConversations);
});

app.post("/api/config", (req, res) => {
  try {
    configuration = { ...configuration, ...req.body };
    console.log("Configuration updated:", configuration);
    res.json({ success: true, message: "Configuration saved successfully" });
  } catch (error) {
    console.error("Error saving configuration:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to save configuration" });
  }
});

app.post("/api/test/:service", async (req, res) => {
  const { service } = req.params;
  const testConfig = req.body;

  try {
    switch (service) {
      case "instagram":
        // Validate required fields first
        if (
          !testConfig.instagram?.pageId ||
          !testConfig.instagram?.accessToken
        ) {
          return res.json({
            success: false,
            error:
              "Missing Instagram Page ID or Access Token. Please check your configuration.",
          });
        }

        // Test Instagram API connection
        try {
          const response = await axios.get(
            `https://graph.facebook.com/v18.0/${testConfig.instagram.pageId}`,
            {
              params: {
                access_token: testConfig.instagram.accessToken,
                fields: "id,name",
              },
              timeout: 10000,
            }
          );
          res.json({ success: true, data: response.data });
        } catch (instagramError) {
          let errorMessage = "Instagram API connection failed";

          if (instagramError.response) {
            const status = instagramError.response.status;
            const errorData = instagramError.response.data;

            switch (status) {
              case 400:
                errorMessage =
                  "Invalid Instagram Page ID or Access Token. Please verify your credentials.";
                break;
              case 401:
                errorMessage =
                  "Instagram Access Token is invalid or expired. Please generate a new token.";
                break;
              case 403:
                errorMessage =
                  "Access denied. Please check your Instagram API permissions.";
                break;
              case 404:
                errorMessage =
                  "Instagram Page not found. Please verify your Page ID.";
                break;
              default:
                errorMessage = `Instagram API error (${status}): ${
                  errorData?.error?.message || "Unknown error"
                }`;
            }
          } else if (instagramError.code === "ENOTFOUND") {
            errorMessage =
              "Network error: Unable to reach Instagram API. Check your internet connection.";
          } else if (instagramError.code === "ETIMEDOUT") {
            errorMessage = "Request timeout: Instagram API is not responding.";
          }

          console.error("Instagram API test error:", instagramError.message);
          res.json({ success: false, error: errorMessage });
        }
        break;

      case "gpt":
        // Validate LLM configuration
        if (!testConfig.gpt?.apiKey) {
          return res.json({
            success: false,
            error: "Missing API Key. Please check your configuration.",
          });
        }

        // Test OpenAI API connection
        try {
          const response = await axios.post(
            testConfig.gpt.endpoint,
            {
              model: testConfig.gpt.model || "gpt-3.5-turbo",
              messages: [{ role: "user", content: "Test message" }],
              max_tokens: 10,
            },
            {
              headers: {
                Authorization: `Bearer ${testConfig.gpt.apiKey}`,
                "Content-Type": "application/json",
              },
              timeout: 15000,
            }
          );
          res.json({ success: true, data: response.data });
        } catch (llmError) {
          let errorMessage = "LLM API connection failed";

          if (llmError.response) {
            const status = llmError.response.status;
            const errorData = llmError.response.data;

            switch (status) {
              case 401:
                errorMessage = "Invalid API Key. Please check your API key.";
                break;
              case 403:
                errorMessage =
                  "Access forbidden. Please check your API permissions.";
                break;
              case 429:
                errorMessage =
                  "API rate limit exceeded. Please try again later.";
                break;
              case 500:
                errorMessage = "API server error. Please try again later.";
                break;
              default:
                errorMessage = `API error (${status}): ${
                  errorData?.error?.message || "Unknown error"
                }`;
            }
          }

          console.error("LLM API test error:", llmError.message);
          res.json({ success: false, error: errorMessage });
        }
        break;

      case "booking":
        // Validate booking URL
        if (!testConfig.booking?.calendlyUrl) {
          return res.json({
            success: false,
            error: "Missing booking URL. Please check your configuration.",
          });
        }

        // Test booking URL accessibility
        try {
          const bookingResponse = await axios.head(
            testConfig.booking.calendlyUrl,
            {
              timeout: 10000,
            }
          );
          res.json({ success: bookingResponse.status === 200 });
        } catch (bookingError) {
          let errorMessage = "Booking URL is not accessible";

          if (bookingError.response) {
            errorMessage = `Booking URL returned status ${bookingError.response.status}`;
          } else if (bookingError.code === "ENOTFOUND") {
            errorMessage =
              "Booking URL not found. Please check the URL format.";
          }

          console.error("Booking URL test error:", bookingError.message);
          res.json({ success: false, error: errorMessage });
        }
        break;

      default:
        res.status(400).json({ success: false, message: "Unknown service" });
    }
  } catch (error) {
    console.error(`Error testing ${service}:`, error);
    res.json({
      success: false,
      error: `Unexpected error testing ${service}: ${error.message}`,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Instagram AI Chatbot server running on port ${PORT}`);
  console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`🔧 Admin dashboard: http://localhost:5173`);
});

export default app;
