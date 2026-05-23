# LINE Bot - Group Chat Summarizer

LINE group chat bot that summarizes conversations using Gemini AI.

## Features

- Type `seiri shite` (整理して) in a group chat to get a summary
- - Analyzes conversation history and returns:
  -   - Project progress summary
      -   - Per-member task list
          -   - Unassigned tasks
              -   - Decisions made and pending items
               
                  - ## Tech Stack
               
                  - - Node.js
                    - - Vercel (Serverless Functions)
                      - - Gemini API (gemini-1.5-flash)
                        - - LINE Messaging API
                         
                          - ## Files
                         
                          - ```
                            line-bot/
                              api/
                                webhook.js      # Main bot handler
                              package.json      # Dependencies
                              vercel.json       # Vercel config
                              .env.example      # Environment variable template
                              README.md         # This file
                            ```

                            ## Deploy Steps

                            ### 1. LINE Developers Setup

                            1. Go to https://developers.line.biz/ja/
                            2. 2. Create a Provider
                               3. 3. Go to https://manager.line.biz and create an Official Account
                                  4. 4. Enable Messaging API in the account settings
                                     5. 5. Get Channel Secret (Basic settings) and Channel Access Token (Messaging API tab)
                                       
                                        6. ### 2. Gemini API Key
                                       
                                        7. 1. Go to https://aistudio.google.com
                                           2. 2. Create an API key
                                             
                                              3. ### 3. GitHub Setup
                                             
                                              4. 1. Create a new repository named `line-bot`
                                                 2. 2. Upload all files from this project
                                                   
                                                    3. ### 4. Vercel Deploy
                                                   
                                                    4. 1. Go to https://vercel.com and log in with GitHub
                                                       2. 2. Import the `line-bot` repository
                                                          3. 3. Set the following environment variables:
                                                             4.    - `LINE_CHANNEL_SECRET`
                                                                   -    - `LINE_CHANNEL_ACCESS_TOKEN`
                                                                        -    - `GEMINI_API_KEY`
                                                                             - 4. Deploy and copy the deployment URL
                                                                              
                                                                               5. ### 5. LINE Webhook Setup
                                                                              
                                                                               6. 1. Go to LINE Developers Console - Messaging API settings
                                                                                  2. 2. Set Webhook URL: `https://your-vercel-url.vercel.app/api/webhook`
                                                                                     3. 3. Enable Webhook
                                                                                        4. 4. Disable auto-reply messages in LINE Official Account Manager
                                                                                          
                                                                                           5. ## How to Use
                                                                                          
                                                                                           6. 1. Add the bot to a LINE group chat
                                                                                              2. 2. Chat normally - the bot records all messages
                                                                                                 3. 3. Type `seiri shite` (整理して) to get a summary of the conversation
                                                                                                   
                                                                                                    4. ## Notes
                                                                                                   
                                                                                                    5. - Chat history is stored in memory only - it resets when Vercel restarts
                                                                                                       - - The bot requires group chat member profile permission to get member names
                                                                                                         - 

