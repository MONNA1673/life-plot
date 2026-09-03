import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import {
  getStoredTasks,
  saveStoredTasks,
  addStoredTask,
  addMultipleStoredTasks,
  updateStoredTask,
  deleteStoredTask,
  resetStoredTasks,
} from './server/taskStorage';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Google Gen AI
let aiClient: GoogleGenAI | null = null;
function getAIClient(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasGeminiKey: !!process.env.GEMINI_API_KEY });
});

// Task storage endpoints
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await getStoredTasks();
    res.json({ tasks });
  } catch (err: any) {
    console.error('Failed to get tasks:', err);
    res.status(500).json({ error: 'Failed to retrieve tasks' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const task = req.body;
    if (!task || !task.id || !task.title) {
      return res.status(400).json({ error: 'Invalid task object' });
    }
    const updatedList = await addStoredTask(task);
    res.json({ success: true, task, tasks: updatedList });
  } catch (err: any) {
    console.error('Failed to add task:', err);
    res.status(500).json({ error: 'Failed to save task' });
  }
});

app.post('/api/tasks/bulk', async (req, res) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'Invalid tasks array' });
    }
    const updatedList = await addMultipleStoredTasks(tasks);
    res.json({ success: true, tasks: updatedList });
  } catch (err: any) {
    console.error('Failed to bulk add tasks:', err);
    res.status(500).json({ error: 'Failed to save tasks' });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const { updatedTask, tasks } = await updateStoredTask(id, updates);
    if (!updatedTask) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json({ success: true, task: updatedTask, tasks });
  } catch (err: any) {
    console.error('Failed to update task:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updatedList = await deleteStoredTask(id);
    res.json({ success: true, tasks: updatedList });
  } catch (err: any) {
    console.error('Failed to delete task:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.post('/api/tasks/sync', async (req, res) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'Tasks must be an array' });
    }
    await saveStoredTasks(tasks);
    res.json({ success: true, tasks });
  } catch (err: any) {
    console.error('Failed to sync tasks:', err);
    res.status(500).json({ error: 'Failed to sync tasks' });
  }
});

app.post('/api/tasks/reset', async (req, res) => {
  try {
    const tasks = await resetStoredTasks();
    res.json({ success: true, tasks });
  } catch (err: any) {
    console.error('Failed to reset tasks:', err);
    res.status(500).json({ error: 'Failed to reset tasks' });
  }
});

// API: Parse natural language tasks with Gemini
app.post('/api/parse-task', async (req, res) => {
  const { prompt, referenceDate } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const ai = getAIClient();
  const refDateStr = referenceDate || new Date().toISOString().split('T')[0];

  if (!ai) {
    // If no API key configured, inform client so it can seamlessly use client heuristic fallback
    return res.json({
      fallback: true,
      message: 'GEMINI_API_KEY not configured, fallback will be used',
    });
  }

  try {
    const systemPrompt = `You are Life Plot, an expert AI personal life admin assistant.
Your job is to parse natural, everyday human language into structured, high-value life admin tasks.
The user is adding one or multiple tasks.
The reference today's date is: ${refDateStr}.

Important guidelines for Life Plot:
1. Title: Clean, action-oriented, professional title (e.g. "Renew car registration with DMV", "Schedule annual dental cleaning & exam", "Pay estimated quarterly taxes").
2. Due Date: Calculate exact ISO date (YYYY-MM-DD) relative to ${refDateStr}.
   - E.g., "in November" -> calculate the first or 15th of November relative to reference year.
   - "next Tuesday" -> calculate the exact upcoming Tuesday.
   - "in 2 weeks" -> add 14 days.
   - "tomorrow" -> add 1 day.
3. Priority: "urgent" (critical/overdue/penalty risk), "high" (important deadline/health), "medium" (standard routine admin), or "low" (someday/leisure).
4. Category: Must be one of:
   - "Vehicles & DMV"
   - "Health & Medical"
   - "Finance & Taxes"
   - "Home & Utilities"
   - "Family & Kids"
   - "Career & Work"
   - "Personal & Leisure"
   - "Legal & Admin"
   - "Other"
5. Estimated Minutes: Realistic time to complete (e.g. 15, 30, 45, 60 mins).
6. Recurrence: "none", "daily", "weekly", "monthly", "yearly".
7. Reminder Setting: "none", "in_2_minutes", "on_due_date", "1_day_before", "1_hour_before". If the user explicitly asks to test or be reminded in 2 minutes, choose "in_2_minutes". If they ask to be reminded (e.g., "remind me 1 day before", "remind me on the day", "remind me to..."), specify the appropriate timing.
8. Checklist: 2 to 4 concrete, bite-sized actionable sub-steps that remove friction.
9. PrepTips: 1 to 2 smart life admin tips (e.g., "Have vehicle VIN & current insurance card handy", "Check if clinic is in-network").
10. Notes: Helpful summary context from prompt.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: `Parse this natural language input into one or more structured tasks:\n"${prompt}"`,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: 'Clear, actionable task title' },
                  dueDate: { type: Type.STRING, description: 'ISO date YYYY-MM-DD' },
                  dueTime: { type: Type.STRING, description: 'Optional HH:mm if time mentioned' },
                  relativeDueLabel: { type: Type.STRING, description: 'Human friendly label like "Next Tuesday" or "In November"' },
                  priority: { type: Type.STRING, enum: ['urgent', 'high', 'medium', 'low'] },
                  category: { 
                    type: Type.STRING, 
                    enum: [
                      'Vehicles & DMV',
                      'Health & Medical',
                      'Finance & Taxes',
                      'Home & Utilities',
                      'Family & Kids',
                      'Career & Work',
                      'Personal & Leisure',
                      'Legal & Admin',
                      'Other'
                    ] 
                  },
                  estimatedMinutes: { type: Type.INTEGER },
                  recurrence: { type: Type.STRING, enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'] },
                  reminderSetting: {
                    type: Type.STRING,
                    enum: ['none', 'in_2_minutes', 'on_due_date', '1_day_before', '1_hour_before'],
                    description: 'Reminder timing option requested by the user'
                  },
                  notes: { type: Type.STRING },
                  checklist: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  },
                  prepTips: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  },
                  tags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  }
                },
                required: ['title', 'dueDate', 'priority', 'category', 'estimatedMinutes']
              }
            }
          },
          required: ['tasks']
        }
      }
    });

    const parsedJson = JSON.parse(response.text?.trim() || '{"tasks":[]}');
    res.json(parsedJson);
  } catch (error: any) {
    console.error('Error parsing task with Gemini:', error);
    res.status(500).json({
      error: 'Failed to parse task with AI',
      details: error?.message || String(error),
      fallback: true
    });
  }
});

// API: Break down task into actionable steps
app.post('/api/breakdown-task', async (req, res) => {
  const { title, category, notes } = req.body;
  const ai = getAIClient();

  if (!ai) {
    return res.json({
      steps: [
        'Review current requirements and gathered documents',
        'Schedule appointment or initiate online submission',
        'Complete action and save confirmation receipt'
      ],
      prepTips: ['Keep digital copy of all confirmation numbers'],
      estimatedMinutes: 30
    });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: `Task Title: ${title}\nCategory: ${category}\nNotes: ${notes || 'None'}\n\nPlease break down this life admin task into 3-5 concrete frictionless micro-steps and provide preparation tips.`,
      config: {
        systemInstruction: 'You are a life admin executive assistant. Break down life admin tasks into straightforward, low-stress sequential steps with practical prep tips.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            steps: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            prepTips: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            estimatedMinutes: { type: Type.INTEGER }
          },
          required: ['steps', 'prepTips', 'estimatedMinutes']
        }
      }
    });

    const result = JSON.parse(response.text?.trim() || '{}');
    res.json(result);
  } catch (error: any) {
    console.error('Error breaking down task:', error);
    res.status(500).json({ error: error?.message || 'Breakdown failed' });
  }
});

// API: Generate phone call script or email template for life admin
app.post('/api/generate-call-script', async (req, res) => {
  const { title, category, details } = req.body;
  const ai = getAIClient();

  if (!ai) {
    return res.json({
      callScript: `Hello, my name is [Your Name]. I am calling regarding ${title}. Could you please help me with the next steps or scheduling?`,
      talkingPoints: ['State your name and account/policy number', 'Explain the purpose of call clearly', 'Ask for confirmation email or reference number'],
      questionsToAsk: ['What documents do I need to bring?', 'Is there a deadline or fee associated?']
    });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: `Generate a polite, concise phone call script and checklist of questions for the following life admin task:\nTitle: ${title}\nCategory: ${category}\nDetails: ${details || 'Standard inquiry'}`,
      config: {
        systemInstruction: 'You are an executive life admin helper. Generate ready-to-read phone scripts and questions that eliminate phone anxiety and get quick resolution.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            callScript: { type: Type.STRING, description: 'Verbatim script to say over the phone' },
            talkingPoints: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Key points to mention'
            },
            questionsToAsk: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Questions to clarify during the call'
            }
          },
          required: ['callScript', 'talkingPoints', 'questionsToAsk']
        }
      }
    });

    const result = JSON.parse(response.text?.trim() || '{}');
    res.json(result);
  } catch (error: any) {
    console.error('Error generating call script:', error);
    res.status(500).json({ error: error?.message || 'Script generation failed' });
  }
});

// Vite middleware and static serving
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Life Plot server listening on http://0.0.0.0:${PORT}`);
  });
}

start();
