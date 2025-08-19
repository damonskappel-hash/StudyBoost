import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { getModelConfig } from '@/lib/config'
import { EnhancementSettings } from '@/lib/types'
import { auth } from '@clerk/nextjs/server'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const enhancementPrompts = {
  structure: `Organize this content with clear headings, bullet points, and logical flow. 
  Make it easy to read and understand for students.`,
  
  definitions: `Identify technical terms, jargon, or complex concepts and provide clear, 
  student-friendly definitions for each. Format as: **Term**: Definition`,
  
  questions: `Generate 3-5 study questions from this content that would help students 
  test their understanding. Include both factual and conceptual questions.`,
  
  summary: `Create concise summaries of each major section. Highlight key takeaways 
  and main points that students should remember.`,
  
  examples: `Add relevant examples, analogies, or real-world applications for abstract 
  concepts mentioned in the content.`,
}

export async function POST(request: NextRequest) {
  try {
    const { userId, has } = await auth()
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    const isStudent = has?.({ plan: 'student' }) ?? false
    const isPro = (has?.({ plan: 'pro' }) ?? false) || (has?.({ plan: 'premium' }) ?? false)
    const isPaid = isStudent || isPro

    const { noteId, originalContent, subject, enhancementSettings } = await request.json()

    // If free plan, force basic-only enhancement regardless of client settings
    const effectiveSettings: EnhancementSettings = isPaid ? enhancementSettings : {
      includeDefinitions: true,
      generateQuestions: false,
      createSummary: false,
      addExamples: false,
      structureLevel: 'basic',
      autoGenerateFlashcards: false,
    }

    // Check content length (approximate token count: 1 token ≈ 4 characters)
    const estimatedTokens = Math.ceil(originalContent.length / 4)
    const model = process.env.OPENAI_MODEL || "gpt-3.5-turbo"
    const modelConfig = getModelConfig(model)
    const maxTokens = modelConfig.maxInputTokens
    
    console.log(`Using model: ${model} (${modelConfig.name})`)
    console.log(`Estimated tokens: ${estimatedTokens}/${maxTokens}`)
    
    if (estimatedTokens > maxTokens) {
      return NextResponse.json({
        success: false,
        error: `Content too large (${estimatedTokens} estimated tokens). Please reduce content to under ${maxTokens * 4} characters.`,
        estimatedTokens,
        maxTokens: maxTokens * 4
      }, { status: 400 })
    }

    if (!process.env.OPENAI_API_KEY) {
      // Return a mock enhanced content for testing without API key
      const mockEnhancedContent = `# Enhanced: ${subject}

## Summary
This is a mock enhancement since no OpenAI API key is configured. Please add your OpenAI API key to the .env.local file for full functionality.

## Original Content
${originalContent}

## Study Questions
1. What are the main points covered in this content?
2. How can you apply these concepts in practice?
3. What questions do you have about this material?

## Key Terms
- **Term**: Definition would appear here with real API
- **Concept**: Explanation would appear here with real API

---

      return NextResponse.json({
        success: true,
        enhancedContent: mockEnhancedContent,
        processingTime: 1000,
        wordCount: mockEnhancedContent.split(/\s+/).length
      })
    }

    const startTime = Date.now()
    
    let prompt = "You are an expert educational assistant helping to enhance student notes. ";
    prompt += `The content is from a ${subject} class. `;
    prompt += "Please enhance this content to make it more organized, clear, and study-friendly.\n\n";
    prompt += `Original content:\n${originalContent}\n\n`;

    // Add enhancement instructions based on settings
    const enhancements: string[] = []
    
    if (effectiveSettings.structureLevel === "comprehensive") {
      enhancements.push(enhancementPrompts.structure)
    } else if (effectiveSettings.structureLevel === "detailed") {
      enhancements.push("Organize this content with clear headings and bullet points.")
    }
    
    if (effectiveSettings.includeDefinitions) {
      enhancements.push(enhancementPrompts.definitions)
    }
    
    if (effectiveSettings.generateQuestions) {
      enhancements.push(enhancementPrompts.questions)
    }
    
    if (effectiveSettings.createSummary) {
      enhancements.push(enhancementPrompts.summary)
    }
    
    if (effectiveSettings.addExamples) {
      enhancements.push(enhancementPrompts.examples)
    }

    prompt += `Enhancement instructions:\n${enhancements.join('\n\n')}\n\n`
    prompt += "Please provide the enhanced content in markdown format. ";
    prompt += "Make it well-structured, easy to read, and study-friendly. ";
    prompt += "If you add definitions, format them as **Term**: Definition. ";
    prompt += "If you add questions, format them as ### Study Questions followed by numbered questions. ";
    prompt += "If you add summaries, format them as ### Summary followed by bullet points.";

    const completion = await openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: "system",
          content: "You are an expert educational assistant that helps students improve their notes. Always respond in markdown format and focus on clarity, organization, and educational value."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: modelConfig.maxOutputTokens,
    })

    const enhancedContent = completion.choices[0]?.message?.content || ""
    const processingTime = Date.now() - startTime
    const wordCount = enhancedContent.split(/\s+/).length

    return NextResponse.json({
      success: true,
      enhancedContent,
      processingTime,
      wordCount
    })
  } catch (error: any) {
    console.error('Enhancement error:', error)
    
    // Handle specific OpenAI errors
    if (error.code === 'rate_limit_exceeded') {
      return NextResponse.json({
        success: false,
        error: 'Rate limit exceeded. Please wait a moment and try again, or reduce the content size.',
        details: 'OpenAI rate limit hit. Try with shorter content.'
      }, { status: 429 })
    }
    
    if (error.status === 429) {
      return NextResponse.json({
        success: false,
        error: 'Content too large for processing. Please reduce the content size and try again.',
        details: 'Token limit exceeded. Try with shorter content.'
      }, { status: 400 })
    }
    
    return NextResponse.json(
      { success: false, error: 'Failed to enhance note. Please try again.' },
      { status: 500 }
    )
  }
}
