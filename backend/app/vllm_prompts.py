"""Prompt constants for vLLM meta-agent calls."""

MATH_SYSTEM_PROMPT = """You are a helpful assistant.

MASness (How much Multi-Agent System-ness): Minimal

Valid Channels: thinking, agent, answer

Model: gpt-oss-120b

An agent is a pre-configured AI personalities that can delegate tasks to. Each subagent:
1. Has a specific purpose and expertise area
2. Uses its own context window separate from the main conversation
3. (Optional) Can be configured with specific tools it's allowed to use
4. Includes a custom system prompt that guides its behavior

An agent can only call within the <thinking> channel, it should be defined in tag <agent>. Each agent must contain <agent_name>, <agent_description>, <required_arguments>, <agent_output_id>


DO NOT MISS ANY REQUEST FIELDS and ensure that your response is a well-formed XML object!"""


MATH_USER_PROMPT_TEMPLATE = """Please solve the question step by step and create agents to delegate the task when necessary. First decide whether to solve directly or to delegate to exactly one agent. If you delegate, you must define that agent by outputting <agent> with agent_name (select one of the agents: CoTAgent, SCAgent, DebateAgent, ReflexionAgent), agent_description, required_arguments, and agent_output_id.
The final output of the delegated agent (identified by its agent_output_id) must represent the complete and final answer to the original question, not an intermediate result.
Always put either the final value or the agent_output_id in the <answer> tag, and use EXACTLY the same field names defined for the agent. If the selected agent uses roles (e.g., DebateAgent), also output debate_roles.

For example,

If you decide to solve the entire task yourself, you will output the following:

Question: What is (20+9)*(30+7)?

 <thinking>
   The problem only requires basic arithmetic.
    No specialized reasoning agent or multi-agent discussion is needed.
    (20+9)*(30+7) = 600 + 140 + 270 + 63 = 1073.
  </thinking>
  <answer>1073</answer>

If you decide to solve the entire task via delegation, you will output the following. In this case, since the agent_input is the same as the original task, you must set the agent_input as empty (\"\"), and the parser will replace it with the original question.

Question: Compute the definite integral of (2x + 5) dx from 0 to 3.

  <thinking>
    This problem involves symbolic integration and applying the Fundamental Theorem of Calculus.
    It requires structured reasoning rather than simple numeric computation.
    I will use a calculus agent that can perform step-by-step Chain-of-Thought reasoning.
    The final answer to the original question will be the output of the CoTAgent.
  </thinking>
  <agent>
    <agent_name>CoTAgent</agent_name>
    <agent_description>Definite integrals with one Chain-of-Thought call.</agent_description>
      <required_arguments>
        <agent_input></agent_input>
      </required_arguments>
      <agent_output_id>
      calc_agent_output
      </agent_output_id>
  </agent>
  <answer>calc_agent_output</answer>

Another example:

Question: What is 17 cubed?

  <thinking>
    Computing 17\u00b3 can be done directly, but arithmetic mistakes are easy to make.
    Using a Chain-of-Thought with Self-Consistency (CoT_SC) allows sampling multiple reasoning paths and combining results for accuracy.
    The final answer to the original question will be the output of the SCAgent.

  </thinking>
  <agent>
    <agent_name>SCAgent</agent_name>
    <agent_description>Performs arithmetic calculations using Chain-of-Thought with Self-Consistency (CoT_SC).</agent_description>
    <required_arguments>
      <agent_input></agent_input>
    </required_arguments>
      <agent_output_id>math_agent_output</agent_output_id>
  </agent>
  <answer>math_agent_output</answer>

More examples:

Question: Given x\u00b2 = 46.694444, which target number is closer, 45 or 46?

  <thinking>
    This question requires comparison between two close numeric choices.
    To ensure accuracy, I will let two reasoning roles debate \u2014 one focusing on mathematical precision and the other on practical rounding.
    The DebateAgent can capture both perspectives and reach a justified final answer.
    The final answer will be the output of the DebateAgent.
  </thinking>
  <agent>
    <agent_name>DebateAgent</agent_name>
    <agent_description>Near-tie numeric choice using one Debate call.</agent_description>
      <required_arguments>
        <agent_input></agent_input>
        <debate_roles>[\"Mathematics Professor\", \"Statistics Teacher\"]</debate_roles>
      </required_arguments>
      <agent_output_id>compare_agent_output</agent_output_id>
  </agent>
  <answer>compare_agent_output</answer>


Final example:

Question: A train travels 60 miles per hour. How far does it go in 2.5 hours?

  <thinking>
    This task requires reasoning with a formula and ensuring units are handled correctly.
    I will use a Reflexion agent that can reflect on and refine its reasoning if errors occur.
    The final answer to the original question will be the output of the ReflexionAgent.

  </thinking>
  <agent>
    <agent_name>ReflexionAgent</agent_name>
    <agent_description>Solves reasoning tasks with iterative self-reflection and critique using Reflexion.</agent_description>
      <required_arguments>
        <agent_input></agent_input>
      </required_arguments>
      <agent_output_id>reflexion_agent_output</agent_output_id>
  </agent>
  <answer>reflexion_agent_output</answer>

If you decide to decompose the question into smaller reasoning steps before delegation, you will output the following. In this case, the agent_input is not empty and serves as the specific sub-task for the agent to solve, while the parser automatically prepends the original question as context before the provided agent_input content. Delegation must occur only after you have completed all reasoning steps \u2014 that is, it should appear in the final step of your reasoning process.


Question: Compute the square root of the average of the first five prime numbers (2, 3, 5, 7, 11), rounded to three decimals.

  <thinking>
    Step 1: Compute the average manually:
      sum = 2 + 3 + 5 + 7 + 11 = 28
      avg = 28 / 5 = 5.6

    Step 2:
      The remaining step \u2014 computing sqrt(5.6) to three decimals \u2014 requires precision and numeric refinement.
      I will delegate that part to a ReflexionAgent using the ReflexionAgent for self-correction if rounding is wrong.
      The final answer to the original question will be the output of the ReflexionAgent.

  </thinking>
  <agent>
    <agent_name>ReflexionAgent</agent_name>
    <agent_description>Square root with a light self-refine loop (single agent call).</agent_description>
      <required_arguments>
          <agent_input>Compute sqrt(5.6) to 3 decimals</agent_input>
      </required_arguments>
      <agent_output_id>numeric_agent_output</agent_output_id>
  </agent>
  <answer>numeric_agent_output</answer>


Below is the question to solve:

{question}"""


MATH_USER_SUFFIX = """Channels:
- <thinking>: internal reasoning and planning
- <agent>: definition of agents
- <answer>: final user-facing answer

Model (the Large lanaguge model used in agent:
- gpt-4.1-nano: Fastest, most cost-efficient version of GPT-4.1. GPT-4.1 nano excels at instruction following and tool calling. It features a 1M token context window, and low latency without a reasoning step. 1,047,576 context window. 32,768 max output tokens. Jun 01, 2024 knowledge cutoff
- gpt-oss-120b: state-of-the-art language models that deliver strong real-world performance at low cost. outperform similarly sized open models on reasoning tasks, demonstrate strong tool use capabilities, and are optimized for efficient deployment on consumer hardware. It was trained using a mix of reinforcement learning and techniques informed by OpenAI's most advanced internal models, including o3 and other frontier systems. It achieves near-parity with OpenAI o4-mini on core reasoning benchmarks. It also perform strongly on tool use, few-shot function calling, CoT reasoning (as seen in results on the Tau-Bench agentic evaluation suite) and HealthBench (even outperforming proprietary models like OpenAI o1 and GPT-4o). 131,072 context window, 131,072 max output tokens, Jun 01, 2024 knowledge cutoff, Reasoning token support

MASness Levels:
- minimal: direct solve or at most one agent
- medium:  one or more agents delegation
- high: complex multi-agent delegation


Sub-agent Schema (all fields required):
<agent>
    <agent_name>...</agent_name> (select one of the agents: CoTAgent, SCAgent, DebateAgent, ReflexionAgent)
    <agent_description>...</agent_description>
    <required_arguments> (make sure all required parameters are set. Must follow XML format)
        <...>...</...>
        <...>...</...>
    </required_arguments>
    <agent_output_id>
    ...
    </agent_output_id>
</agent>

Available Agents:

CoTAgent: {\"desciption\": \"By encouraging the LLM to think step by step rather than directly outputting an answer, chain-of-thought reasoning enables complex problem-solving through intermediate steps. This practice improves the model's ability to handle tasks that require deeper reasoning and provides insight into its decision-making process.\", \"name\": \"Chain-of-Thought Agent (CoTAgent)\", \"required_arguments\": {\"agent_input\": \"The input for the CoTAgent. This is the task question for the CoT LLM to solve. If left empty (\\\"\\\") the parser will automatically replace it with the original question.\"}, \"implementation\": \"def CoTAgent(self, agent_input, model: str):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    \\n    # Basic setting\\n    temperature = 0.5\\n    \\n    # Instruction for the Chain-of-Thought (CoT) approach\\n    # It is an important practice that allows the LLM to think step by step before solving the task.\\n    cot_instruction = \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instantiate a new LLM specifically for CoT\\n    # To allow LLM thinking before answering, we need to set an additional output field 'thinking'.\\n    cot_agent = LLMAgentBase(['thinking', 'answer'], 'Chain-of-Thought LLM', model=model, temperature=temperature)\\n\\n    # Get the response from the CoT tool\\n    thinking, answer = cot_agent([agent_input], cot_instruction)\\n    final_answer = self.make_final_answer(thinking, answer)\\n    \\n    # Return only the final answer\\n    return final_answer   \\n\"}

SCAgent: {\"desciption\": \"While an LLM can arrive at the correct answer, its reasoning may vary. By repeatedly asking the same question with high temperature settings, we can generate different reasoning paths. We then combine multiple answers from these Chain-of-Thought (CoTAgent) agents to produce a more accurate final answer through ensembling. Best for problems where you want high confidence through consensus.\", \"name\": \"Self-Consistency with Chain-of-Thought (SCAgent)\", \"required_arguments\": {\"agent_input\": \"The input for the SCAgent. This is the task question for the CoT_SC LLM to solve. If left empty (\\\"\\\"), the parser will automatically replace it with the original question.\"}, \"implementation\": \"def SCAgent(self, agent_input, model: str):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    # Basic setting\\n    temperature = 0.5\\n    num_repeated_samples = 5\\n\\n    # Instruction for step-by-step reasoning\\n    cot_instruction =  \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instruction for step-by-step reasoning\\n    # Initialize multiple CoT agents with a higher temperature for varied reasoning\\n    cot_agents = [LLMAgentBase(['thinking', 'answer'], 'Chain-of-Thought LLM', model=model, temperature=temperature) for _ in range(num_repeated_samples)]\\n    \\n    thinking_mapping = {}\\n    answer_mapping = {}\\n    possible_answers = []\\n    for i in range(num_repeated_samples):\\n        thinking, answer = cot_agents[i]([agent_input], cot_instruction)\\n        possible_answers.append(answer.content)\\n        thinking_mapping[answer.content] = thinking\\n        answer_mapping[answer.content] = answer\\n\\n    # Ensembling the answers from multiple CoT agents\\n    answer = self.majority_voting(possible_answers)\\n\\n    thinking = thinking_mapping[answer]\\n    answer = answer_mapping[answer]\\n\\n    final_answer = self.make_final_answer(thinking, answer)\\n\\n    return final_answer  \\n\"}

DebateAgent: {\"desciption\": \"By letting different LLMs debate with each other, we can leverage their diverse perspectives to find better solutions for tasks. Best for problems that benefit from multiple perspectives.\", \"name\": \"LLM Debate (DebateAgent)\", \"required_arguments\": {\"agent_input\": \"The input for the DebateAgent. This is the task question or context for the Debate LLM to solve. If left empty (\\\"\\\") the parser will automatically replace it with the original question.\", \"debate_roles\": \"A list of roles (musst be more than one) for the DebateAgent (e.g., 'Mathematics Professor', 'Statistician'). Each role represents a distinct perspective and viewpoint.\"}, \"implementation\": \"def DebateAgent(self, agent_input, model: str, debate_roles: List[str]):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    # Basic setting\\n    temperature = 0.5\\n    max_debate_round = 5\\n\\n    # Instruction for initial reasoning\\n    debate_initial_instruction =  \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instruction for debating and updating the solution based on other agents' solutions\\n    debate_instruction = \\\"Given solutions to the problem from other agents, consider their opinions as additional advice. Please think carefully and provide an updated answer. Put your thinking process in the 'thinking' field and the updated answer in the 'answer' field. \\\"\\n\\n    # Initialize debate agents with different roles and a moderate temperature for varied reasoning\\n    debate_agents = [LLMAgentBase(['thinking', 'answer'], 'Debate LLM', model=model, role=role, temperature=temperature) for role in debate_roles]\\n\\n    # Instruction for final decision-making based on all debates and solutions\\n    final_decision_instruction = \\\"Given all the above thinking and answers, reason over them carefully and provide a final answer. Put your thinking process in the 'thinking' field and the final answer in the 'answer' field.\\\"\\n\\n\\n    final_decision_agent = LLMAgentBase(['thinking', 'answer'], 'Final Decision LLM', model=model, temperature=temperature)\\n\\n    all_thinking = [[] for _ in range(max_debate_round)]\\n    all_answer = [[] for _ in range(max_debate_round)]\\n\\n    # Perform debate rounds\\n    for r in range(max_debate_round):\\n        for i in range(len(debate_agents)):\\n            if r == 0:\\n                thinking, answer = debate_agents[i]([agent_input], debate_initial_instruction)\\n            else:\\n                input_infos = [agent_input] + [all_thinking[r-1][i]] + all_thinking[r-1][:i] + all_thinking[r-1][i+1:]\\n                thinking, answer = debate_agents[i](input_infos, debate_instruction)\\n            all_thinking[r].append(thinking)\\n            all_answer[r].append(answer)\\n    \\n    # Make the final decision based on all debate results and solutions\\n    thinking, answer = final_decision_agent([agent_input] + all_thinking[max_debate_round-1] + all_answer[max_debate_round-1], final_decision_instruction)\\n    final_answer = self.make_final_answer(thinking, answer)\\n\\n    return final_answer\\n\"}

ReflexionAgent: {\"desciption\": \"To enhance its performance, an LLM can iteratively improve its answer based on feedback. By reflecting on its previous attempts and incorporating feedback, the model can refine its reasoning and provide a more accurate solution. Best for complex problems that benefit from self-correction.\", \"name\": \"Self-Refine (Reflexion)\", \"required_arguments\": {\"agent_input\": \"The input for the ReflexionAgent. This is the task question for the CoT LLM to solve. If left empty (\\\"\\\") the parser will automatically replace it with the original question.\"}, \"implementation\": \"def ReflexionAgent(self, agent_input, model: str):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    # Basic setting\\n    temperature = 0.5\\n    max_reflection_round = 5\\n\\n    # Instruction for initial reasoning\\n    initial_instruction = \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instruction for reflecting on previous attempts and feedback to improve\\n    reflect_instruction = \\\"Given previous attempts and feedback, carefully consider where you could go wrong in your latest attempt. Using insights from previous attempts, try to solve the task better.\\\"\\n    cot_agent = LLMAgentBase(['thinking', 'answer'], 'Chain-of-Thought LLM', model=model, temperature=temperature)\\n\\n    # Instruction for providing feedback and correcting the answer\\n    critic_instruction = \\\"Please review the answer above and criticize on where might be wrong. If you are absolutely sure it is correct, output exactly 'True' in 'correct'.\\\"\\n\\n    critic_agent = LLMAgentBase(['feedback', 'correct'], 'Critic LLM', model=model, temperature=temperature)\\n        \\n    # Initial attempt\\n    cot_inputs = [agent_input]\\n    thinking, answer = cot_agent(cot_inputs, initial_instruction, 0)\\n\\n    for i in range(max_reflection_round):\\n        # Get feedback and correct status from the critic\\n        feedback, correct = critic_agent([agent_input, thinking, answer], critic_instruction, i)\\n        if correct.content == 'True':\\n            break\\n            \\n        # Add feedback to the inputs for the next iteration\\n        cot_inputs.extend([thinking, answer, feedback])\\n\\n        # Reflect on previous attempts and refine the answer\\n        thinking, answer = cot_agent(cot_inputs, reflect_instruction, i + 1)\\n\\n    final_answer = self.make_final_answer(thinking, answer)\\n\\n    return final_answer\\n\"}"""


MAS_SYSTEM_PROMPT = """You are a helpful assistant.

MASness (How much Multi-Agent System-ness): Medium

Valid Channels: thinking, agent, edge

Model: gpt-oss-120b

An agent is a pre-configured AI personalities that can delegate tasks to. Each subagent:
1. Has a specific purpose and expertise area
2. Uses its own context window separate from the main conversation
3. (Optional) Can be configured with specific tools it's allowed to use
4. Includes a custom system prompt that guides its behavior

An agent should be defined in channel <agent>. Each agent must contain <agent_id>, <agent_name>, <agent_description>, <required_arguments>. To connect multiple agents to form a multi-agent system, use <edge> channel.


DO NOT MISS ANY REQUEST FIELDS and ensure that your response is a well-formed XML object!"""


MAS_USER_PROMPT_TEMPLATE = """Please solve the given question by creating one or more agents and connecting them into a valid computational graph that collaboratively produces the final answer. To create an agent, you must define that agent by outputting <agent> with agent_id (a unique id for the agent, must be unique and contain only alphanumeric or underscore characters (e.g., A1, Refine_1, WS_Japan)), agent_name (exactly one of: CoTAgent, SCAgent, DebateAgent, ReflexionAgent and WebSearchAgent), agent_description, required_arguments (must include at least one <agent_input> tag. DebateAgents must define <debate_roles> with two or more roles. If  <agent_input> left empty (\"\"), the parser will automatically replace it with the original question.).

After defining all agents, you must build a valid graph by specifying edges that describe the data flow between agents. Output exactly one <edge> block, Each <from> <to> pair connects the output of one agent to the input of another:

<edge>
<from>source_agent_id</from>
<to>target_agent_id</to>
</edge>

You can output multiple <from> and </to> inside the <edge>. Each <from> and <to> value must exactly match an existing <agent_id>.

To be valid, your graph must satisfy all of the following constraints:

1. Node consistency: Every <from> and <to> must reference a valid <agent_id> that appears in an <agent> block.
2. Directionality: Edges are directed: data flows from <from> \u2192 <to>.
3. Connectivity: Every agent must be connected directly or indirectly to the main flow. Isolated agents are not allowed.
4. Start node(s): At least one agent must have no incoming edge. These are \"entry points\" (e.g., WebSearch or initial reasoning).
5. Sink node: There must be exactly one agent with no outgoing edge \u2014 this is the FINAL agent that produces the answer.
6. No undefined edges: It is invalid to reference an agent in <from> or <to> that was not declared.
7. No loops or cycles: No self-loop: <from>X</from><to>X</to> is not allowed. No cycles: The graph must be acyclic; a topological order must exist.
8. Parallelism allowed: Multiple agents may have the same <from> or <to> (fan-out/fan-in).
9. Unambiguous sink: The parser will reject graphs with multiple sinks (add a final \"collector\" agent if needed).
10. Order-independent: The XML order of edges does not need to follow execution order; topological sorting is handled automatically.
11. Sink answer completeness: The unique sink agent's output must directly answer the original question in a user-ready form. It must not be an intermediate artifact (e.g., notes, critique, raw table) unless the question explicitly asks for that artifact. If <agent_input> is empty for the sink, it inherits the original question and must return the final answer. If <agent_input> is non-empty, the runner still prepends the original question as context; the sink must still produce the final, user-facing answer to that question.
12. Edge-Data Flow Consistency (BIDIRECTIONAL): Edges represent execution order. ${} represents data flow. As a result, you must ensure they are consistent with each other.
    a) If an <agent_input> references ${X}, there MUST be an edge <from>X</from><to>THIS_AGENT</to>
    b) If there is an edge <from>X</from><to>Y</to>, then Y's <agent_input> MUST reference ${X}
    In other words: edges exist if and only if there is actual data passing from one agent to another. Do not create edges solely for execution ordering without data flow.

Thinking Section (Required):

Before defining agents and edges, you must include a <thinking> section.
It should naturally describe why multiple agents are needed, why each type was chosen, and why the graph has that structure (parallel, sequential or hybrid).
It must justify both planning and design rationale.

Example structure:

<thinking>
  Explain why a single agent is insufficient.
  Describe each agent's role and how they connect.
  Justify the flow pattern (parallel, sequential, hybrid).
  End by clearly stating which agent produces the final output.
</thinking>


Single-agent example:

If you decide to solve via single agent, you will output the following. In this case, since the agent_input is the same as the original task, you must set the agent_input as empty (\"\"), and the parser will replace it with the original question.

1st example:

Question: Compute the definite integral of (2x + 5) dx from 0 to 3.

  <thinking>
    This problem involves symbolic integration and applying the Fundamental Theorem of Calculus.
    It requires structured reasoning rather than simple numeric computation.
    I will use a calculus agent that can perform step-by-step Chain-of-Thought reasoning.
    The final answer to the original question will be the output of the CoTAgent.
  </thinking>
  <agent>
    <agent_id>calc_agent</agent_id>
    <agent_name>CoTAgent</agent_name>
    <agent_description>Definite integrals with one Chain-of-Thought call.</agent_description>
      <required_arguments>
        <agent_input></agent_input>
      </required_arguments>
  </agent>

2nd example:

Question: What is 17 cubed?

  <thinking>
    Computing 17\u00b3 can be done directly, but arithmetic mistakes are easy to make.
    Using a Chain-of-Thought with Self-Consistency (CoT_SC) allows sampling multiple reasoning paths and combining results for accuracy.
    The final answer to the original question will be the output of the SCAgent.

  </thinking>
  <agent>
    <agent_id>math_agent</agent_id>
    <agent_name>SCAgent</agent_name>
    <agent_description>Performs arithmetic calculations using Chain-of-Thought with Self-Consistency (CoT_SC).</agent_description>
    <required_arguments>
      <agent_input></agent_input>
    </required_arguments>
  </agent>

3rd examples:

Question: Given x\u00b2 = 46.694444, which target number is closer, 45 or 46?

<thinking>
  This question requires comparison between two close numeric choices.
  To ensure accuracy, I will let two reasoning roles debate \u2014 one focusing on mathematical precision and the other on practical rounding.
  The DebateAgent can capture both perspectives and reach a justified final answer.
  The final answer will be the output of the DebateAgent.
</thinking>
<agent>
  <agent_id>compare_agent</agent_id>
  <agent_name>DebateAgent</agent_name>
  <agent_description>Near-tie numeric choice using one Debate call.</agent_description>
    <required_arguments>
      <agent_input></agent_input>
      <debate_roles>[\"Mathematics Professor\", \"Statistics Teacher\"]</debate_roles>
    </required_arguments>
</agent>


4th example:

Question: A train travels 60 miles per hour. How far does it go in 2.5 hours?

<thinking>
  This task requires reasoning with a formula and ensuring units are handled correctly.
  I will use a Reflexion agent that can reflect on and refine its reasoning if errors occur.
  The final answer to the original question will be the output of the ReflexionAgent.

</thinking>
<agent>
  <agent_id>reflexion_agent</agent_id>
  <agent_name>ReflexionAgent</agent_name>
  <agent_description>Solves reasoning tasks with iterative self-reflection and critique using Reflexion.</agent_description>
    <required_arguments>
      <agent_input></agent_input>
    </required_arguments>
</agent>

5th example:

Question: What is the current inflation rate in Japan as of this month?

<thinking>
  This question depends on up-to-date factual information that cannot be reliably recalled from static knowledge.
  Using a single WebSearchAgent is sufficient because the task only requires retrieving accurate, cited facts from the web, not further reasoning or synthesis.
  The agent will search online sources and return a concise, citation-based summary.
  The WebSearchAgent is therefore both the only node and the final output of the flow.
</thinking>

<agent>
  <agent_id>SEARCH</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Retrieves recent and cited factual information from the internet.</agent_description>
  <required_arguments>
    <agent_input></agent_input>
  </required_arguments>
</agent>

Multi-Agent Example:

If you decide to solve via multiple agents, you must first decompose the original question into smaller, well-defined sub-tasks, each representing a single sub-goal. Then, create one agent per sub-task and connect them into a coherent, acyclic computational graph.

In this case, the agent_input is not empty and serves as the specific sub-task for the agent to solve, while the parser automatically prepends the original question as context before the provided agent_input content.

When decomposing:

1. Keep sub-tasks minimal and focused. Each agent should handle one atomic objective (e.g., one query, one reasoning step, or one verification task).
2. Use multiple WebSearchAgents for different pieces of factual evidence, rather than a single broad search.
3. Connect agents logically so that information flows toward a single final agent (the sink) that directly answers the original question.


1st example:

Question: Give a short, cited summary of the most recent housing vacancy rates for New York City, Los Angeles, and Chicago

<thinking>
  We need up-to-date numbers with sources, so we will run three WebSearch agents in parallel.
  Then a CoT agent will normalize the three snippets into a small table.
  An SC agent will run small variants and vote to reduce extraction errors.
  A Reflexion agent will check units, recency, and citations.
  A final CoT agent will write the short summary.
  The final sink is FINAL.
</thinking>

<agent>
  <agent_id>WS_NYC</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Find the latest NYC housing vacancy rate with source text.</agent_description>
  <required_arguments>
    <agent_input>Search for the latest official or reputable estimate of the housing vacancy rate for New York City. Return a short snippet with the number, date, and a citation line.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>WS_LA</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Find the latest LA vacancy rate with source text.</agent_description>
  <required_arguments>
    <agent_input>Search for the latest official or reputable estimate of the housing vacancy rate for Los Angeles. Return a short snippet with the number, date, and a citation line.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>WS_CHI</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Find the latest Chicago vacancy rate with source text.</agent_description>
  <required_arguments>
    <agent_input>Search for the latest official or reputable estimate of the housing vacancy rate for Chicago. Return a short snippet with the number, date, and a citation line.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>EXT</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Extract numbers and standardize the three rates with dates and citations.</agent_description>
  <required_arguments>
    <agent_input>From the snippets below, extract for each city: city name, vacancy rate (as a percent), reference date (YYYY-MM or YYYY), and a short citation. Output a compact 3-line table.

NYC:
${WS_NYC}

LA:
${WS_LA}

Chicago:
${WS_CHI}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>VOTE</agent_id>
  <agent_name>SCAgent</agent_name>
  <agent_description>Ensemble the extraction to reduce copy or parse errors.</agent_description>
  <required_arguments>
    <agent_input>Given the 3-line table below, produce 5 independent extractions and vote on a single corrected 3-line table.

Table:
${EXT}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>QA</agent_id>
  <agent_name>ReflexionAgent</agent_name>
  <agent_description>Check units, date freshness, and cite presence; list fixes if needed.</agent_description>
  <required_arguments>
    <agent_input>Audit the voted table for: units as %, dates present, and a citation per city. If any issue is found, list concrete fixes in 3 lines; else say OK. End with a 1-line verdict.

Voted table:
${VOTE}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>FINAL</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Write the short, cited summary.</agent_description>
  <required_arguments>
    <agent_input>Using the checked table and notes, write a 3\u20134 sentence summary with one sentence per city and a final sentence comparing the rates. Keep citations as inline source lines from the table.

Table:
${VOTE}

QA notes:
${QA}</agent_input>
  </required_arguments>
</agent>

<edge>
<from>WS_NYC</from><to>EXT</to>
<from>WS_LA</from><to>EXT</to>
<from>WS_CHI</from><to>EXT</to>
<from>EXT</from><to>VOTE</to>
<from>VOTE</from><to>QA</to>
<from>VOTE</from><to>FINAL</to>
<from>QA</from><to>FINAL</to>
</edge>


2nd example:
Question: During Pope John Paul II's first foreign journey in the late 1970s, he visited a country known for its rich Mesoamerican history and home to a large population. On which other date did he visit a major city on the Adriatic Sea, known for its significant port and a famous basilica dedicated to a saint with the initial \"S\", and which other nearby city did he visit on the same day?

<thinking>
  The question needs historical reasoning: identify Pope John Paul II's first foreign trip, find an Adriatic city he visited with a basilica of a saint starting with \"S\", get the date, and determine another city visited the same day.

  One agent cannot do all of this because it mixes retrieval and reasoning.
  I will decompose it into smaller sub-tasks: three WebSearchAgents for each factual lookup, one CoTAgent to build a timeline, one ReflexionAgent to verify consistency, and a final CoTAgent to write the answer.
  The FINAL agent outputs the final answer.
</thinking>

<agent>
  <agent_id>WS_FIRST_TRIP</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Retrieve Pope John Paul II's first foreign trip details in the late 1970s.</agent_description>
  <required_arguments>
    <agent_input>Search for Pope John Paul II's first foreign journey (year, destination country, and duration).
Return the trip date range, destination, and a reliable citation.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>WS_ADRIATIC</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Find Adriatic Sea city visits with basilicas dedicated to saints starting with 'S'.</agent_description>
  <required_arguments>
    <agent_input>Search for any Adriatic city visited by Pope John Paul II that has a basilica dedicated to a saint with the initial 'S'
(e.g., Saint Nicholas, Saint Mark).
Return the city name, basilica name, and visit date, with citation.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>WS_SAME_DAY</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Identify any other nearby city visited by Pope John Paul II on the same day as the Adriatic visit.</agent_description>
  <required_arguments>
    <agent_input>Search for other cities visited by Pope John Paul II on the same date as his Adriatic visit.
Return the nearby city name, distance estimate, and source citation.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>TIMELINE</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Integrate trip data into a single verified historical timeline.</agent_description>
  <required_arguments>
    <agent_input>Using the results below:
First foreign journey: ${WS_FIRST_TRIP}
Adriatic visit: ${WS_ADRIATIC}
Same-day visit: ${WS_SAME_DAY}
Build a clear timeline confirming the Adriatic visit date and same-day nearby city.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>VERIFY</agent_id>
  <agent_name>ReflexionAgent</agent_name>
  <agent_description>Validate chronology, geography, and saint-basilica link.</agent_description>
  <required_arguments>
    <agent_input>Check consistency among timeline facts:
- Ensure the same date appears across all sources.
- Confirm the Adriatic city is geographically near the second city.
- Verify that the basilica indeed honors a saint whose name starts with \"S\".
Return OK if consistent, otherwise list corrections.

Timeline to verify:
${TIMELINE}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>FINAL</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Produce the final concise answer with the date and both cities.</agent_description>
  <required_arguments>
    <agent_input>Using verified results, answer in one sentence:
\"Pope John Paul II visited [ADRIATIC_CITY] on [DATE], home to the Basilica of Saint [S], and also visited [NEARBY_CITY] on the same day.\"
Include a brief verification sentence citing sources.
Timeline: ${TIMELINE}
Verification: ${VERIFY}</agent_input>
  </required_arguments>
</agent>

<edge>
  <from>WS_FIRST_TRIP</from><to>TIMELINE</to>
  <from>WS_ADRIATIC</from><to>TIMELINE</to>
  <from>WS_SAME_DAY</from><to>TIMELINE</to>
  <from>TIMELINE</from><to>VERIFY</to>
  <from>VERIFY</from><to>FINAL</to>
  <from>TIMELINE</from><to>FINAL</to>
</edge>

3rd example:

Question: Based on economic data, which region (Asia or Europe) is currently leading in green energy investment?

<thinking>
  This task requires retrieving multiple data sources, performing region-specific analysis, comparing them, and ensuring factual coherence.
  A single agent might provide a rough answer but would likely mix fabricated numbers with true ones.
  I will therefore design a diamond-shaped multi-agent graph for balanced analysis and verification.

  One WebSearchAgent will gather data from multiple global sources.
  Two CoTAgents will independently analyze the data for Asia and Europe, each focusing on investment scale and growth rate.
  Their outputs will merge in a DebateAgent that compares the two sides and recommends the leading region.
  A ReflexionAgent will audit that recommendation for factual alignment with the original search data.
  Finally, a CoTAgent will synthesize the audit and recommendation into the final answer.
  The structure forms a diamond: a single source branches into two analyses, converges via debate, splits for verification, and merges again for the final synthesis.
  The final answer comes from the FINAL agent.
</thinking>

<agent>
  <agent_id>SEARCH</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Gather recent statistics on green energy investment.</agent_description>
  <required_arguments>
    <agent_input>Find data on green energy investment (USD) by region for Asia and Europe from recent reports.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>ASIA</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Analyze data for Asia.</agent_description>
  <required_arguments>
    <agent_input>Using these data, summarize green investment trends for Asia.

${SEARCH}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>EUROPE</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Analyze data for Europe.</agent_description>
  <required_arguments>
    <agent_input>Using these data, summarize green investment trends for Europe.

${SEARCH}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>COMPARE</agent_id>
  <agent_name>DebateAgent</agent_name>
  <agent_description>Compare Asia vs Europe and recommend which leads.</agent_description>
  <required_arguments>
    <agent_input>Debate between the two analyses and select the leading region with reasoning.

Asia:
${ASIA}

Europe:
${EUROPE}</agent_input>
    <debate_roles>[\"Energy Economist\",\"Policy Analyst\"]</debate_roles>
  </required_arguments>
</agent>

<agent>
  <agent_id>AUDIT</agent_id>
  <agent_name>ReflexionAgent</agent_name>
  <agent_description>Verify factual alignment with source data.</agent_description>
  <required_arguments>
    <agent_input>Check if the debate conclusion aligns with the original data. Identify and fix any inconsistencies.

Debate conclusion:
${COMPARE}

Original data:
${SEARCH}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>FINAL</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Summarize the verified result with citations.</agent_description>
  <required_arguments>
    <agent_input>Summarize the verified findings and cite key data points.

Original data:
${SEARCH}

Audit:
${AUDIT}</agent_input>
  </required_arguments>
</agent>

<from>SEARCH</from><to>ASIA</to>
<from>SEARCH</from><to>EUROPE</to>
<from>ASIA</from><to>COMPARE</to>
<from>EUROPE</from><to>COMPARE</to>
<from>SEARCH</from><to>AUDIT</to>
<from>COMPARE</from><to>AUDIT</to>
<from>AUDIT</from><to>FINAL</to>

4th example:

Question: Estimate annual CO\u2082 reduction if 1,000 gasoline taxis switch to EVs, using recent grid intensity.

<thinking>
  This estimate needs recent factual factors and careful arithmetic. A single agent could try to search and compute in one pass, but that risks using stale figures and mixing retrieval with calculation errors.
  I will split responsibilities: two WebSearchAgents retrieve the latest grid CO\u2082 intensity (gCO\u2082/kWh) and a credible gasoline tailpipe factor (gCO\u2082/mile), with citations. A CoTAgent will state two explicit assumptions (miles per taxi per year and EV kWh per mile) because these are context-dependent and not fixed in a single source.
  Another CoTAgent will then perform the full calculation for 1,000 taxis using the retrieved factors and stated assumptions, showing the intermediate terms so the math can be checked.
  To make the result robust, an SCAgent will generate small variants (\u00b110% on the two assumptions) and vote for a single number. A ReflexionAgent will audit units, sanity (e.g., non-negative, plausible scale), and consistency with the cited factors.
  Finally, a CoTAgent will write a concise paragraph reporting the reduction, the assumptions, and both citations. The searches and assumptions can run in parallel; the calculation, vote, audit, and final write-up are sequential because each depends on the prior outputs. The final sink is FINAL.
</thinking>

<agent>
  <agent_id>WS_GRID</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Find the most recent grid CO\u2082 intensity (gCO\u2082/kWh) with a clear citation and date.</agent_description>
  <required_arguments>
    <agent_input>Retrieve the latest average grid CO\u2082 intensity (gCO\u2082/kWh) for the relevant region. Return the numeric value, the reference period, and a one-line citation.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>WS_GAS</agent_id>
  <agent_name>WebSearchAgent</agent_name>
  <agent_description>Find a credible gasoline tailpipe CO\u2082 factor (gCO\u2082/mile) with a citation.</agent_description>
  <required_arguments>
    <agent_input>Retrieve a credible average tailpipe CO\u2082 emission factor for gasoline cars (gCO\u2082/mile). Return the numeric value, any key assumption notes, and a one-line citation.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>ASSUMP</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>State two explicit assumptions needed for the calculation.</agent_description>
  <required_arguments>
    <agent_input>Provide two numbers with one-line justifications: (1) miles driven per taxi per year; (2) EV energy intensity in kWh per mile. Note one sentence on uncertainty.</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>CALC</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Compute annual CO\u2082 reduction for 1,000 taxis using factors and assumptions, showing the arithmetic.</agent_description>
  <required_arguments>
    <agent_input>Using the inputs below, compute:
Gas = 1000 * miles_per_year * gCO2_per_mile
EV  = 1000 * miles_per_year * kWh_per_mile * gCO2_per_kWh
Reduction = Gas - EV
Return the three lines above with the substituted numbers and a final Reduction (metric tons).

Grid intensity:
${WS_GRID}

Gasoline factor:
${WS_GAS}

Assumptions:
${ASSUMP}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>SC</agent_id>
  <agent_name>SCAgent</agent_name>
  <agent_description>Stabilize the estimate by small variations and voting.</agent_description>
  <required_arguments>
    <agent_input>Generate 5 short variants by applying \u00b110% to miles_per_year and kWh_per_mile, recompute Reduction for each, and vote for one final numeric value with brief confidence.

Base calculation:
${CALC}</agent_input>
    <n_samples>5</n_samples>
    <vote_method>majority</vote_method>
  </required_arguments>
</agent>

<agent>
  <agent_id>QA</agent_id>
  <agent_name>ReflexionAgent</agent_name>
  <agent_description>Audit units, plausibility, and consistency with cited factors; flag and fix minor issues.</agent_description>
  <required_arguments>
    <agent_input>Check that the voted Reduction is consistent with the CALC arithmetic and the cited factors from WS_GRID and WS_GAS. Verify units and plausible scale. If a small issue is found, state a corrected note; otherwise say OK.

Voted result:
${SC}

Base calculation:
${CALC}

Grid intensity:
${WS_GRID}

Gasoline factor:
${WS_GAS}</agent_input>
  </required_arguments>
</agent>

<agent>
  <agent_id>FINAL</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>Write the final sourced result.</agent_description>
  <required_arguments>
    <agent_input>In 5\u20137 sentences, report the annual CO\u2082 reduction for 1,000 taxis, the two assumptions, and cite both factors. Include a one-line caveat on uncertainty.

Voted estimate:
${SC}

QA notes:
${QA}</agent_input>
  </required_arguments>
</agent>

<edge>
  <from>WS_GRID</from><to>CALC</to>
  <from>WS_GAS</from><to>CALC</to>
  <from>ASSUMP</from><to>CALC</to>
  <from>CALC</from><to>SC</to>
  <from>SC</from><to>QA</to>
  <from>CALC</from><to>QA</to>
  <from>WS_GRID</from><to>QA</to>
  <from>WS_GAS</from><to>QA</to>
  <from>SC</from><to>FINAL</to>
  <from>QA</from><to>FINAL</to>
</edge>


Final Checklist:
1. Unique IDs: Every <agent_id> is unique and uses only letters, digits, or underscores (A1, WS_Grid, Final_1, etc.). Bellow is WRONG as there are two FINAL agents:
<agent>
  <agent_id>FINAL</agent_id>
  <agent_name>CoTAgent</agent_name>
  <required_arguments><agent_input></agent_input></required_arguments>
</agent>

<agent>
  <agent_id>FINAL</agent_id>
  <agent_name>SCAgent</agent_name>
  <required_arguments><agent_input></agent_input></required_arguments>
</agent>
2. Declared First\tAll <agent> blocks appear before any <edge> definitions.
3. Connected Graph\tNo isolated agents \u2014 each must connect directly or indirectly to the main flow. Bellow is WRONG as B is isolated agent:
<agent>
  <agent_id>A</agent_id>
  <agent_name>CoTAgent</agent_name>
  <required_arguments><agent_input></agent_input></required_arguments>
</agent>

<agent>
  <agent_id>B</agent_id>
  <agent_name>CoTAgent</agent_name>
  <required_arguments><agent_input></agent_input></required_arguments>
</agent>

<edge>
  <from>A</from><to>FINAL</to>
</edge>
4. At Least One Start Node:\tAt least one agent has no incoming edge (e.g., WebSearch or initial reasoning).
5. Exactly One Sink Node\tExactly one agent has no outgoing edge \u2014 this is the final output (sink). Bellow is WRONG as there are two sink nodes (B and C):
<edge>
  <from>A</from><to>B</to>
  <from>A</from><to>C</to>
</edge>
6. No Dangling Edges:\tEvery <from> and <to> exactly matches an existing <agent_id>. Bellow is WRONG as B is not an existing <agent_id>:
<agent>
  <agent_id>A</agent_id>
  <agent_name>CoTAgent</agent_name>
  <agent_description>...</agent_description>
  <required_arguments><agent_input></agent_input></required_arguments>
</agent>

<edge>
  <from>A</from><to>B</to>
</edge>
7. No Duplicates in Edges: Do not define the same <from> <to> link twice. Bellow is WRONG as it defines the same <from> <to> link twice:
<edge>
  <from>A</from><to>B</to>
  <from>A</from><to>B</to>
</edge>
8. Parallel Allowed\tFan-out and fan-in are fine (e.g., multiple <from>s into one <to>).
9. Edge-Data Flow Consistency: Every edge must correspond to actual data flow. If <from>X</from><to>Y</to> exists, then Y's <agent_input> MUST include ${X}. Conversely, if Y uses ${X}, you MUST have an edge <from>X</from><to>Y</to>. Below is WRONG because edge C\u2192D exists but D doesn't use ${C}:
<agent>
  <agent_id>C</agent_id>
  <agent_name>CoTAgent</agent_name>
  <required_arguments><agent_input>Analyze data.</agent_input></required_arguments>
</agent>
<agent>
  <agent_id>D</agent_id>
  <agent_name>CoTAgent</agent_name>
  <required_arguments><agent_input>Make final decision.</agent_input></required_arguments>
</agent>
<edge>
  <from>C</from><to>D</to>
</edge>
The correct version should have D use ${C}: <agent_input>Make final decision based on: ${C}</agent_input>
10. Consistent Agent Types:\tEach agent uses only one of the allowed names: CoTAgent, SCAgent, DebateAgent, ReflexionAgent, or WebSearchAgent.
11. No Self-Loops: Never link an agent to itself. No Cycles: The graph must be a DAG (topological order exists). Bellow is WRONG as there is a cycle (A -> B -> C -> A) and cycle (REFLECT -> REFLECT):
<edge>
  <from>A</from><to>B</to>
  <from>B</from><to>C</to>
  <from>C</from><to>A</to>
  <from>REFLECT</from><to>REFLECT</to>
</edge>


Below is the question to solve:

{question}"""


MAS_USER_SUFFIX = """Channels:
- <thinking>: internal reasoning and planning
- <agent>: definition of agents
- <edge>: definition of edges

Model (the Large lanaguge model used in agent:
- gpt-oss-120b: state-of-the-art language models that deliver strong real-world performance at low cost. outperform similarly sized open models on reasoning tasks, demonstrate strong tool use capabilities, and are optimized for efficient deployment on consumer hardware. It was trained using a mix of reinforcement learning and techniques informed by OpenAI's most advanced internal models, including o3 and other frontier systems. It achieves near-parity with OpenAI o4-mini on core reasoning benchmarks. It also perform strongly on tool use, few-shot function calling, CoT reasoning (as seen in results on the Tau-Bench agentic evaluation suite) and HealthBench (even outperforming proprietary models like OpenAI o1 and GPT-4o). 131,072 context window, 131,072 max output tokens, Jun 01, 2024 knowledge cutoff, Reasoning token support

MASness Levels:
- medium: one or more agents delegation


Sub-agent Schema (all fields required):
<agent>
    <agent_id>...</agent_id> (a unique id for the agent)
    <agent_name>...</agent_name> (select one of the agents: CoTAgent, SCAgent, DebateAgent, ReflexionAgent)
    <agent_description>...</agent_description>
    <required_arguments> (make sure all required parameters are set. Must follow XML format)
        <...>...</...>
        <...>...</...>
    </required_arguments>
</agent>

Edge Schema (single block; all fields required. Each pair defines a directed link: output of <from> \u2192 input of <to>. List ALL links here; use exactly one <edge> block per solution):
<edge>
    <from>...</from> (the source agent_id)
    <to>...</to> (the target agent_id)
</edge>

Available Agents:

CoTAgent: {\"desciption\": \"By encouraging the LLM to think step by step rather than directly outputting an answer, chain-of-thought reasoning enables complex problem-solving through intermediate steps. This practice improves the model's ability to handle tasks that require deeper reasoning and provides insight into its decision-making process.\", \"name\": \"Chain-of-Thought Agent (CoTAgent)\", \"required_arguments\": {\"agent_input\": \"The input for the CoTAgent. This is the task question for the CoTAgent to solve. If left empty (\\\"\\\") the parser will automatically replace it with the original question.\"}, \"implementation\": \"async def CoTAgent(self, agent_input, model: str):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    \\n    # Basic setting\\n    temperature = 0.5\\n    \\n    # Instruction for the Chain-of-Thought (CoT) approach\\n    # It is an important practice that allows the LLM to think step by step before solving the task.\\n    cot_instruction = \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instantiate a new LLM specifically for CoT\\n    # To allow LLM thinking before answering, we need to set an additional output field 'thinking'.\\n    cot_agent = LLMAgentBase(['thinking', 'answer'], 'Chain-of-Thought LLM', model=model, temperature=temperature)\\n\\n    # Get the response from the CoT tool\\n    thinking, answer = await cot_agent([agent_input], cot_instruction)\\n    final_answer = self.make_final_answer(thinking, answer)\\n    \\n    # Return only the final answer\\n    return final_answer   \\n\"}

SCAgent: {\"desciption\": \"While an LLM can arrive at the correct answer, its reasoning may vary. By repeatedly asking the same question with high temperature settings, we can generate different reasoning paths. We then combine multiple answers from these Chain-of-Thought (CoTAgent) agents to produce a more accurate final answer through ensembling. Best for problems where you want high confidence through consensus.\", \"name\": \"Self-Consistency with Chain-of-Thought (SCAgent)\", \"required_arguments\": {\"agent_input\": \"The input for the SCAgent. This is the task question for the SCAgent to solve. If left empty (\\\"\\\"), the parser will automatically replace it with the original question.\"}, \"implementation\": \"async def SCAgent(self, agent_input, model: str):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    # Basic setting\\n    temperature = 0.5\\n    num_repeated_samples = 5\\n\\n    # Instruction for step-by-step reasoning\\n    cot_instruction =  \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instruction for step-by-step reasoning\\n    # Initialize multiple CoT agents with a higher temperature for varied reasoning\\n    cot_agents = [LLMAgentBase(['thinking', 'answer'], 'Chain-of-Thought LLM', model=model, temperature=temperature) for _ in range(num_repeated_samples)]\\n    \\n    thinking_mapping = {}\\n    answer_mapping = {}\\n    possible_answers = []\\n    for i in range(num_repeated_samples):\\n        thinking, answer = await cot_agents[i]([agent_input], cot_instruction)\\n        possible_answers.append(answer.content)\\n        thinking_mapping[answer.content] = thinking\\n        answer_mapping[answer.content] = answer\\n\\n    # Ensembling the answers from multiple CoT agents\\n    answer = self.majority_voting(possible_answers)\\n\\n    thinking = thinking_mapping[answer]\\n    answer = answer_mapping[answer]\\n\\n    final_answer = self.make_final_answer(thinking, answer)\\n\\n    return final_answer  \\n\"}

DebateAgent: {\"desciption\": \"By letting different LLMs debate with each other, we can leverage their diverse perspectives to find better solutions for tasks. Best for problems that benefit from multiple perspectives.\", \"name\": \"LLM Debate (DebateAgent)\", \"required_arguments\": {\"agent_input\": \"The input for the DebateAgent. This is the task question or context for the DebateAgent to solve. If left empty (\\\"\\\") the parser will automatically replace it with the original question.\", \"debate_roles\": \"A list of roles (musst be more than one) for the DebateAgent (e.g., 'Mathematics Professor', 'Statistician'). Each role represents a distinct perspective and viewpoint.\"}, \"implementation\": \"async def DebateAgent(self, agent_input, model: str, debate_roles: List[str]):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    # Basic setting\\n    temperature = 0.5\\n    max_debate_round = 5\\n\\n    # Instruction for initial reasoning\\n    debate_initial_instruction =  \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instruction for debating and updating the solution based on other agents' solutions\\n    debate_instruction = \\\"Given solutions to the problem from other agents, consider their opinions as additional advice. Please think carefully and provide an updated answer. Put your thinking process in the 'thinking' field and the updated answer in the 'answer' field. \\\"\\n\\n    # Initialize debate agents with different roles and a moderate temperature for varied reasoning\\n    debate_agents = [LLMAgentBase(['thinking', 'answer'], 'Debate LLM', model=model, role=role, temperature=temperature) for role in debate_roles]\\n\\n    # Instruction for final decision-making based on all debates and solutions\\n    final_decision_instruction = \\\"Given all the above thinking and answers, reason over them carefully and provide a final answer. Put your thinking process in the 'thinking' field and the final answer in the 'answer' field.\\\"\\n\\n\\n    final_decision_agent = LLMAgentBase(['thinking', 'answer'], 'Final Decision LLM', model=model, temperature=temperature)\\n\\n    all_thinking = [[] for _ in range(max_debate_round)]\\n    all_answer = [[] for _ in range(max_debate_round)]\\n\\n    # Perform debate rounds\\n    for r in range(max_debate_round):\\n        for i in range(len(debate_agents)):\\n            if r == 0:\\n                thinking, answer = await debate_agents[i]([agent_input], debate_initial_instruction)\\n            else:\\n                input_infos = [agent_input] + [all_thinking[r-1][i]] + all_thinking[r-1][:i] + all_thinking[r-1][i+1:]\\n                thinking, answer = await debate_agents[i](input_infos, debate_instruction)\\n            all_thinking[r].append(thinking)\\n            all_answer[r].append(answer)\\n    \\n    # Make the final decision based on all debate results and solutions\\n    thinking, answer = await final_decision_agent([agent_input] + all_thinking[max_debate_round-1] + all_answer[max_debate_round-1], final_decision_instruction)\\n    final_answer = self.make_final_answer(thinking, answer)\\n\\n    return final_answer\\n\"}

ReflexionAgent: {\"desciption\": \"To enhance its performance, an LLM can iteratively improve its answer based on feedback. By reflecting on its previous attempts and incorporating feedback, the model can refine its reasoning and provide a more accurate solution. Best for complex problems that benefit from self-correction.\", \"name\": \"Self-Refine (Reflexion)\", \"required_arguments\": {\"agent_input\": \"The input for the ReflexionAgent. This is the task question for the ReflexionAgent to solve. If left empty (\\\"\\\") the parser will automatically replace it with the original question.\"}, \"implementation\": \"async def ReflexionAgent(self, agent_input, model: str):\\n    from mas_r1_reasoner.agents.agent_system import LLMAgentBase, Info\\n    \\n    # Validate that agent_input is an Info object\\n    assert isinstance(agent_input, Info), f\\\"agent_input must be an Info object, got {agent_input}\\\"\\n\\n    # Basic setting\\n    temperature = 0.5\\n    max_reflection_round = 5\\n\\n    # Instruction for initial reasoning\\n    initial_instruction = \\\"Please think step by step and then solve the task.\\\"\\n\\n    # Instruction for reflecting on previous attempts and feedback to improve\\n    reflect_instruction = \\\"Given previous attempts and feedback, carefully consider where you could go wrong in your latest attempt. Using insights from previous attempts, try to solve the task better.\\\"\\n    cot_agent = LLMAgentBase(['thinking', 'answer'], 'Chain-of-Thought LLM', model=model, temperature=temperature)\\n\\n    # Instruction for providing feedback and correcting the answer\\n    critic_instruction = \\\"Please review the answer above and criticize on where might be wrong. If you are absolutely sure it is correct, output exactly 'True' in 'correct'.\\\"\\n\\n    critic_agent = LLMAgentBase(['feedback', 'correct'], 'Critic LLM', model=model, temperature=temperature)\\n        \\n    # Initial attempt\\n    cot_inputs = [agent_input]\\n    thinking, answer = await cot_agent(cot_inputs, initial_instruction, 0)\\n\\n    for i in range(max_reflection_round):\\n        # Get feedback and correct status from the critic\\n        feedback, correct = await critic_agent([agent_input, thinking, answer], critic_instruction, i)\\n        if correct.content == 'True':\\n            break\\n            \\n        # Add feedback to the inputs for the next iteration\\n        cot_inputs.extend([thinking, answer, feedback])\\n\\n        # Reflect on previous attempts and refine the answer\\n        thinking, answer = await cot_agent(cot_inputs, reflect_instruction, i + 1)\\n\\n    final_answer = self.make_final_answer(thinking, answer)\\n\\n    return final_answer\\n\"}

WebSearchAgent: {\"desciption\": \"Web search allows models to access up-to-date information from the internet and provide answers with sourced citations.\", \"name\": \"Web Search Agent (WebSearchAgent)\", \"required_arguments\": {\"agent_input\": \"The input for the SearchAgent. This is the task question for the WebSearchAgent to solve. If left empty (\\\"\\\") the parser will automatically replace it with the original question.\"}, \"implementation\": \"WebSearchAgent conducts iterative web research using two main tools:\\n    1. web_search tool: Searches the web, retrieves up to 5 results, optionally summarizes webpage content using LLM, and formats output with citations\\n    2. think_tool: Enables reflection after each search to analyze findings, assess gaps, and decide next steps\\n\\n    The agent operates in a tool-calling loop (max 5 iterations by default) following a research workflow:\\n    - Executes searches based on the query\\n    - Reflects on results using think_tool\\n    - Decides whether to continue searching or provide final answer\\n    - Returns comprehensive answer with sources when sufficient information is gathered\"}"""


def build_math_messages(question: str) -> list[dict]:
    return [
        {"role": "system", "content": MATH_SYSTEM_PROMPT},
        {"role": "user", "content": MATH_USER_PROMPT_TEMPLATE.replace("{question}", question)},
        {"role": "user", "content": MATH_USER_SUFFIX},
    ]


def build_mas_messages(question: str) -> list[dict]:
    return [
        {"role": "system", "content": MAS_SYSTEM_PROMPT},
        {"role": "user", "content": MAS_USER_PROMPT_TEMPLATE.replace("{question}", question)},
        {"role": "user", "content": MAS_USER_SUFFIX},
    ]
