/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, Modality } from "@google/genai";
import dotenv from "dotenv";
import { generateFallbackReport } from "./src/fallbackReport";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "5mb" }));

// Helper to safely instantiate Gemini with a clean fallback check
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not configured in Secrets. Please configure it in Settings > Secrets.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

// 1. Geocoding search endpoint
app.get("/api/weather/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "Missing 'q' search query parameter" });
      return;
    }

    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`
    );

    if (!response.ok) {
      throw new Error(`Geocoding service returned status: ${response.status}`);
    }

    const data: any = await response.json();
    const results = (data.results || []).map((item: any) => ({
      name: item.name,
      country: item.country || "",
      state: item.admin1 || "",
      lat: item.latitude,
      lon: item.longitude,
      timezone: item.timezone || "auto",
      countryCode: item.country_code || "",
    }));

    res.json({ results });
  } catch (error: any) {
    console.error("Geocoding error:", error);
    res.status(500).json({ error: error.message || "Failed to search location" });
  }
});

// 2. Weather & Air Quality Telemetry endpoint
app.get("/api/weather/telemetry", async (req, res) => {
  try {
    const { lat, lon, name, country, countryCode, state, timezone } = req.query;

    if (!lat || !lon) {
      res.status(400).json({ error: "Missing latitude or longitude parameters" });
      return;
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lon as string);
    const tz = (timezone as string) || "auto";

    // Build the weather URL
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,relative_humidity_2m,wind_speed_10m,wind_direction_10m,pressure_msl,cloud_cover,uv_index&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,uv_index,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,precipitation_probability_max&timezone=${encodeURIComponent(tz)}`;

    // Build the air quality URL
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}&current=european_aqi,us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=${encodeURIComponent(tz)}`;

    // Fetch in parallel
    const [weatherRes, aqRes] = await Promise.all([
      fetch(weatherUrl),
      fetch(aqUrl),
    ]);

    if (!weatherRes.ok) throw new Error(`Weather telemetry failed: status ${weatherRes.status}`);
    if (!aqRes.ok) throw new Error(`Air Quality telemetry failed: status ${aqRes.status}`);

    const wData: any = await weatherRes.json();
    const aData: any = await aqRes.json();

    // Map City Info
    const city = {
      name: (name as string) || "Current Location",
      country: (country as string) || "",
      state: (state as string) || "",
      lat: latitude,
      lon: longitude,
      timezone: wData.timezone || tz,
      countryCode: (countryCode as string) || "",
    };

    // Map Current Weather
    const current = {
      temp: wData.current.temperature_2m,
      feltTemp: wData.current.apparent_temperature,
      weatherCode: wData.current.weather_code,
      humidity: wData.current.relative_humidity_2m,
      windSpeed: wData.current.wind_speed_10m,
      windDir: wData.current.wind_direction_10m,
      pressure: wData.current.pressure_msl,
      cloudCover: wData.current.cloud_cover,
      uvIndex: wData.current.uv_index || 0,
      isDay: wData.current.is_day === 1,
    };

    // Map Hourly Forecast (next 24 hours)
    const hourly = [];
    const nowHourIndex = Math.max(0, new Date().getHours());
    // Get up to 24 hourly steps starting around the current hour
    for (let i = nowHourIndex; i < nowHourIndex + 24; i++) {
      if (wData.hourly.time[i]) {
        hourly.push({
          time: wData.hourly.time[i],
          temp: wData.hourly.temperature_2m[i],
          precipProb: wData.hourly.precipitation_probability[i] || 0,
          humidity: wData.hourly.relative_humidity_2m[i],
          uvIndex: wData.hourly.uv_index[i] || 0,
          windSpeed: wData.hourly.wind_speed_10m[i],
        });
      }
    }

    // Map Daily Forecast (next 7 days)
    const daily = [];
    const dailyCount = wData.daily.time.length;
    for (let i = 0; i < dailyCount; i++) {
      daily.push({
        date: wData.daily.time[i],
        weatherCode: wData.daily.weather_code[i],
        tempMax: wData.daily.temperature_2m_max[i],
        tempMin: wData.daily.temperature_2m_min[i],
        feltMax: wData.daily.apparent_temperature_max[i],
        feltMin: wData.daily.apparent_temperature_min[i],
        uvMax: wData.daily.uv_index_max[i] || 0,
        precipSum: wData.daily.precipitation_sum[i] || 0,
        precipProbMax: wData.daily.precipitation_probability_max ? wData.daily.precipitation_probability_max[i] : 0,
        sunrise: wData.daily.sunrise[i],
        sunset: wData.daily.sunset[i],
        daylightHours: Math.round((wData.daily.daylight_duration[i] / 3600) * 10) / 10,
      });
    }

    // Map Air Quality
    const airQuality = {
      usAqi: aData.current.us_aqi || 0,
      euAqi: aData.current.european_aqi || 0,
      pm25: aData.current.pm2_5 || 0,
      pm10: aData.current.pm10 || 0,
      co: aData.current.carbon_monoxide || 0,
      no2: aData.current.nitrogen_dioxide || 0,
      so2: aData.current.sulphur_dioxide || 0,
      o3: aData.current.ozone || 0,
    };

    res.json({
      city,
      current,
      hourly,
      daily,
      airQuality,
    });
  } catch (error: any) {
    console.error("Telemetry fetch error:", error);
    res.status(500).json({ error: error.message || "Failed to retrieve telemetry data" });
  }
});

// 3. Gemini Weather Intelligence generator endpoint
app.post("/api/weather/intelligence", async (req, res) => {
  const { weatherData, persona } = req.body;
  if (!weatherData) {
    res.status(400).json({ error: "Missing weatherData in request body" });
    return;
  }

  try {
    const ai = getGeminiClient();

    // Construct profile instructions based on persona
    let profileGuideline = "";
    switch (persona) {
      case "athlete":
        profileGuideline = "Focus heavily on athletic performance, cardiovascular efficiency, thermal comfort, optimal outdoor training windows, joint pain warnings (pressure drops), wind impact, hydration needs, and air quality risk levels for heavy aerobic exertion.";
        break;
      case "parent":
        profileGuideline = "Focus heavily on children's safety, stroller comfort, appropriate layering, sunscreen thresholds, insect activity conditions, indoor play alternatives if wet/unhealthy, packing requirements (diapers, hats, snacks), and risk parameters (cold, heat indices, high wind, poor AQI).";
        break;
      case "traveler":
        profileGuideline = "Focus heavily on travel delays, flight cancellations (high winds/fog/snow), luggage preparation, transit safety, dress codes for business/dining, key local attractions suitability, and local custom adjustment advice.";
        break;
      case "gardener":
        profileGuideline = "Focus heavily on soil moisture, evaporation rates, frost damage windows, plant watering optimization, greenhouse ventilation, high-wind protection for fragile flora, pest vulnerabilities, and ideal pruning/harvesting times.";
        break;
      case "energy":
        profileGuideline = "Focus heavily on home energy efficiency, heating/cooling presets, optimal appliance usage windows, natural ventilation drafts, peak demand mitigation, solar generation capability, and weatherization micro-steps.";
        break;
      default:
        profileGuideline = "Focus on a balanced general overview covering commuter readiness, health exposure (UV & Air Quality), outfit recommendations, general task scheduling, and quick, practical tips for everyday productivity.";
    }

    // Build the weather payload description
    const weatherString = JSON.stringify({
      city: weatherData.city,
      current: weatherData.current,
      airQuality: weatherData.airQuality,
      // Select a short summary of hourly & daily to keep tokens reasonable
      hourlySample: weatherData.hourly.slice(0, 8), 
      dailySample: weatherData.daily.slice(0, 4)
    }, null, 2);

    const systemInstruction = `You are an elite, highly specialized meteorological intelligence officer. Your job is to analyze real-time raw telemetry and generate an advanced, data-driven, hyper-actionable Weather Intelligence Report tailored to the selected user profile.
Guidelines:
1. Ground your conclusions strictly in the provided data (temperatures, AQI, UV, Wind, Pressure, Humidity).
2. Do not use generic filler text or empty advice. Be highly specific and technical yet clear.
3. Keep impact ratings realistic (low, medium, high, critical).
4. Include a beautifully formatted, highly professional Markdown report inside the "markdownText" property. The Markdown should include icons/emojis, strong section headers, custom tables if needed, and read like a confidential briefing.

Selected Profile Target:
${profileGuideline}`;

    const prompt = `Below is the raw weather and air quality telemetry data for ${weatherData.city.name}, ${weatherData.city.state ? weatherData.city.state + ', ' : ''}${weatherData.city.country}:
\`\`\`json
${weatherString}
\`\`\`

Generate a Weather Intelligence Report in JSON format that matches the requested schema. Please ensure all fields are filled accurately and directly align with the persona's priorities.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        systemInstruction,
        temperature: 0.3,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING, description: "A high-level, authoritative executive summary of the day's weather intelligence report tailored to the profile's primary focus." },
            highlights: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: "3-4 essential bullet points highlighting critical milestones (e.g., UV spike times, precipitation onset, air quality alerts, pressure changes)."
            },
            impactAnalysis: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING, description: "Relevant operational area (e.g., Respiratory Health, Structural Comfort, Operations, Energy Demand)" },
                  impact: { type: Type.STRING, description: "Impact rating: 'low', 'medium', 'high', 'critical'" },
                  description: { type: Type.STRING, description: "A precise explanation detailing the thermodynamic or chemical impact on this category." }
                },
                required: ["category", "impact", "description"]
              },
              description: "Assessments for 3-4 key categories affected by today's metrics."
            },
            checklist: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  task: { type: Type.STRING, description: "Specific, actionable task (e.g., 'Deploy heavy mulch to garden beds', 'Ventilate home between 7:00 PM and 10:00 PM')" },
                  reason: { type: Type.STRING, description: "Scientific or practical rationale linking the task directly to telemetry." }
                },
                required: ["task", "reason"]
              },
              description: "A tailored, prioritized action plan for today."
            },
            recommendations: {
              type: Type.OBJECT,
              properties: {
                clothing: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Specific layered garments appropriate for local temps, wind chill, or heat index." },
                gear: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Vital equipment (e.g., wrap-around UV glasses, HEPA mask, wind-resistant canopy, hydration flask)." },
                activityPlanner: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      timeWindow: { type: Type.STRING, description: "Optimized hour range (e.g., '14:00 - 17:00')" },
                      activity: { type: Type.STRING, description: "Recommended or evaluated activity" },
                      suitability: { type: Type.STRING, description: "Suitability: 'excellent', 'good', 'poor'" },
                      reason: { type: Type.STRING, description: "Rationale explaining compatibility with UV, temp, wind, and rain curves." }
                    },
                    required: ["timeWindow", "activity", "suitability", "reason"]
                  },
                  description: "A scheduled timeline of activities optimized against today's atmospheric changes."
                }
              },
              required: ["clothing", "gear", "activityPlanner"]
            },
            markdownText: {
              type: Type.STRING,
              description: "A comprehensive, beautifully formatted report in Markdown. Use elegant structure, headings, bold emphasis, and a technical intelligence brief style to elaborate on recommendations and telemetry."
            }
          },
          required: ["summary", "highlights", "impactAnalysis", "checklist", "recommendations", "markdownText"]
        }
      }
    });

    const text = response.text;
    if (!text) {
      throw new Error("Empty response returned from Gemini API");
    }

    res.json(JSON.parse(text));
  } catch (error: any) {
    console.warn("Gemini Intelligence API failed/unavailable, launching rule-based fallback generator:", error.message || error);
    try {
      const fallbackReport = generateFallbackReport(weatherData, persona);
      res.json(fallbackReport);
    } catch (fallbackError: any) {
      console.error("Critical: Fallback meteorological generator failed:", fallbackError);
      res.status(500).json({ error: error.message || "Failed to generate AI Weather Intelligence report" });
    }
  }
});

// 4. Gemini TTS Voice Briefing endpoint
app.post("/api/weather/tts", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' string in request body" });
      return;
    }

    const ai = getGeminiClient();

    // Generate cheerful voice brief
    const prompt = `You are a professional weather anchor. Read this weather briefing clearly, engagingly, and with natural emphasis:
"${text.slice(0, 400)}"`; // Limit input length slightly for speed and cost efficiency

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' }, // Clear, modern voice
          }
        }
      }
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error("No audio payload returned from Gemini TTS API");
    }

    res.json({ audio: base64Audio });
  } catch (error: any) {
    console.error("Gemini TTS error:", error);
    res.status(500).json({ error: error.message || "Failed to generate TTS audio" });
  }
});

// 5. Integrate Vite Dev Server / Serve Production Static Files
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite dev server middleware mounted.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Serving production static files from /dist.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Weather Intelligence server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
